import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// Disposable PostgreSQL with actual applied migrations, never Prisma db push.
const token = randomUUID().replaceAll("-", "");
const container = `moda-arch035-api015-${token}`;
const db = `knowledge_${token.slice(0, 16)}`;
const user = `knowledge_${token.slice(16, 28)}`;
const password = randomUUID();
const run = (bin, args, options = {}) => execFileSync(bin, args, { encoding: "utf8", stdio: "pipe", ...options });
const docker = (args, options) => run("docker", args, options);
let started = false;
let phase = "starting disposable PostgreSQL";
try {
  docker(["run", "--detach", "--rm", "--name", container,
    "--env", `POSTGRES_DB=${db}`, "--env", `POSTGRES_USER=${user}`,
    "--env", `POSTGRES_PASSWORD=${password}`, "--publish", "127.0.0.1::5432", "pgvector/pgvector:pg17"]);
  started = true;
  phase = "obtaining database port";
  const port = docker(["port", container, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("port unavailable");
  phase = "awaiting database readiness";
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      docker(["exec", container, "psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]);
      ready = true;
      break;
    } catch { await delay(500); }
  }
  if (!ready) throw new Error("database unavailable");
  phase = "creating vector extension";
  docker(["exec", container, "psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);
  const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${db}`;
  const env = { ...process.env, DATABASE_URL: url, WOO_INSTALLATION_TEST_DATABASE_URL: url };
  phase = "generating Prisma client";
  run("npx", ["--no-install", "prisma", "generate", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "deploying migrations";
  run("npx", ["--no-install", "prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "running Merchant Knowledge integration suite";
  run("node", ["--import", "tsx", "--test", "tests/integration/merchant/merchant-knowledge/read.postgres.test.ts",
    "tests/integration/merchant/merchant-knowledge/commands.postgres.test.ts"], { env, stdio: "inherit" });
} catch {
  // Never print the exception: child-process arguments may include generated credentials.
  process.stderr.write(`ARCH-035-API-015 PostgreSQL validation failed during ${phase}.\n`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { docker(["rm", "--force", container]); }
    catch { process.stderr.write("ARCH-035-API-015 PostgreSQL cleanup failed.\n"); process.exitCode = 1; }
  }
}
