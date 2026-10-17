import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const suffix = randomUUID().replaceAll("-", "");
const name = `moda-api-arch035-features-${suffix}`;
const database = `features_${suffix.slice(0, 16)}`;
const user = `features_${suffix.slice(16, 28)}`;
const password = randomUUID();
let started = false;
let phase = "starting PostgreSQL";
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
const docker = (args) => run("docker", args);

try {
  docker(["run", "--detach", "--rm", "--name", name,
    "--env", `POSTGRES_DB=${database}`, "--env", `POSTGRES_USER=${user}`, "--env", `POSTGRES_PASSWORD=${password}`,
    "--publish", "127.0.0.1::5432", "pgvector/pgvector:pg17"]);
  started = true;
  phase = "resolving PostgreSQL port";
  const port = docker(["port", name, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("PostgreSQL port unavailable");
  phase = "checking PostgreSQL readiness";
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try { docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]); ready = true; break; }
    catch { await delay(500); }
  }
  if (!ready) throw new Error("PostgreSQL not ready");
  phase = "enabling pgvector";
  docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);
  const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  const env = { ...process.env, DATABASE_URL: url, WOO_INSTALLATION_TEST_DATABASE_URL: url };
  phase = "generating Prisma Client";
  run("npx", ["--no-install", "prisma", "generate", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "deploying migrations";
  run("npx", ["--no-install", "prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "running feature-preference integration tests";
  run("node", ["--import", "tsx", "--test", "--test-concurrency=1",
    "tests/integration/merchant/feature-preferences/service.postgres.test.ts"], { env, stdio: "inherit" });
} catch {
  // Never print execFileSync error objects: Docker argv contains the disposable password.
  process.stderr.write(`ARCH-035 feature-preferences PostgreSQL validation failed while ${phase}.\n`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { docker(["rm", "--force", name]); }
    catch { process.stderr.write("ARCH-035 feature-preferences container cleanup failed.\n"); process.exitCode = 1; }
  }
}
