import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

/** Full fresh-migration disposable proof. No access to the developer's database. */
const suffix = randomUUID().replaceAll("-", "");
const container = `moda-api-arch040-control-${suffix}`;
const database = `control_${suffix.slice(0, 16)}`;
const user = `control_${suffix.slice(16, 28)}`;
const password = randomUUID();
let started = false;
let phase = "starting disposable PostgreSQL";
const exec = (bin, args, options = {}) => execFileSync(bin, args, {
  encoding: "utf8", stdio: "pipe", ...options,
});
const docker = (args) => exec("docker", args);

try {
  docker(["run", "--detach", "--rm", "--name", container, "--env", `POSTGRES_DB=${database}`,
    "--env", `POSTGRES_USER=${user}`, "--env", `POSTGRES_PASSWORD=${password}`,
    "--publish", "127.0.0.1::5432", "pgvector/pgvector:pg17"]);
  started = true;
  phase = "resolving disposable PostgreSQL port";
  const port = docker(["port", container, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("no mapped port");
  phase = "waiting for PostgreSQL readiness";
  let ready = false;
  // The official PostgreSQL image exposes a temporary Unix-socket server while
  // initialising. Checking the TCP listener waits for the final server instead.
  for (let i = 0; i < 60; i++) {
    try {
      docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", user, "-d", database]);
      ready = true;
      break;
    } catch { await delay(500); }
  }
  if (!ready) throw new Error("database not ready");
  phase = "enabling pgvector";
  docker(["exec", container, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);
  const databaseUrl = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  const env = { ...process.env, DATABASE_URL: databaseUrl, WOO_INSTALLATION_TEST_DATABASE_URL: databaseUrl };
  phase = "generating Prisma Client";
  exec("npx", ["--no-install", "prisma", "generate", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "deploying fresh migrations";
  exec("npx", ["--no-install", "prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "running Woo control concurrency and authority tests";
  exec("node", ["--import", "tsx", "--test", "--test-concurrency=1",
    "tests/integration/merchant/conversations/control.service.postgres.test.ts"], { env, stdio: "inherit" });
  process.stdout.write("PASS ARCH-040-API-003 disposable PostgreSQL control suite\n");
} catch {
  // Never print the exception/argv; it may contain generated credentials.
  process.stderr.write(`ARCH-040-API-003 PostgreSQL test failed while ${phase}.\n`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { docker(["rm", "--force", container]); }
    catch { process.stderr.write("ARCH-040-API-003 PostgreSQL cleanup failed.\n"); process.exitCode = 1; }
  }
}
