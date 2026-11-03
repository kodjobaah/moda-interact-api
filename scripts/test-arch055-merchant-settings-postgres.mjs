import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const suffix = randomUUID().replaceAll("-", "");
const name = `moda-api-arch055-settings-${suffix}`;
const database = `settings_${suffix.slice(0, 16)}`;
const user = `settings_${suffix.slice(16, 28)}`;
const password = randomUUID();
const suites = [
  "tests/integration/merchant/bootstrap/bootstrap-read.service.postgres.test.ts",
  "tests/integration/merchant/store-context/store-context.service.postgres.test.ts",
  "tests/integration/merchant/store-categories/store-categories-read.service.postgres.test.ts",
  "tests/integration/merchant/store-categories/store-category-selection.service.postgres.test.ts",
  "tests/integration/merchant/store-categories/arch055-coherent-read.postgres.test.ts",
];
let started = false;
let phase = "starting PostgreSQL 17 with pgvector";
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
const docker = (args, options) => run("docker", args, options);

try {
  docker(["run", "--detach", "--rm", "--name", name,
    "--env", `POSTGRES_DB=${database}`, "--env", `POSTGRES_USER=${user}`, "--env", `POSTGRES_PASSWORD=${password}`,
    "--publish", "127.0.0.1::5432", "pgvector/pgvector:pg17"]);
  started = true;
  phase = "resolving the mapped PostgreSQL port";
  const port = docker(["port", name, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("PostgreSQL port unavailable");
  phase = "checking PostgreSQL readiness";
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]);
      ready = true;
      break;
    } catch { await delay(500); }
  }
  if (!ready) throw new Error("PostgreSQL not ready");
  phase = "enabling pgvector";
  docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);
  const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  const env = { ...process.env, DATABASE_URL: url, WOO_INSTALLATION_TEST_DATABASE_URL: url };
  phase = "generating Prisma Client";
  run("npx", ["--no-install", "prisma", "generate", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "deploying canonical Prisma migrations";
  run("npx", ["--no-install", "prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "running merchant-settings PostgreSQL suites";
  run("node", ["--import", "tsx", "--test", "--test-concurrency=1", ...suites], { env, stdio: "inherit" });
} catch {
  process.stderr.write(`ARCH-055 merchant-settings PostgreSQL validation failed while ${phase}.\n`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { docker(["rm", "--force", name]); }
    catch { process.stderr.write("ARCH-055 merchant-settings container cleanup failed.\n"); process.exitCode = 1; }
  }
}