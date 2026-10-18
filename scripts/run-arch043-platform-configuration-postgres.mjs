import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// Dedicated disposable container only. Never reuse a developer database.
const token = randomUUID().replaceAll("-", "");
const container = `moda-arch043-api001-${token}`;
const db = `config_${token.slice(0, 16)}`;
const user = `config_${token.slice(16, 28)}`;
const password = randomUUID();
const run = (bin, args, options = {}) => execFileSync(bin, args,
  { encoding: "utf8", stdio: "pipe", ...options });
const docker = (args, options) => run("docker", args, options);
let started = false;
let phase = "creating disposable PostgreSQL";
try {
  docker(["run", "--detach", "--rm", "--name", container,
    "--label", "moda.arch043.api001=disposable", "--env", `POSTGRES_DB=${db}`,
    "--env", `POSTGRES_USER=${user}`, "--env", `POSTGRES_PASSWORD=${password}`,
    "--publish", "127.0.0.1::5432", "pgvector/pgvector:pg17"]);
  started = true;
  phase = "obtaining database port";
  const port = docker(["port", container, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("port unavailable");
  phase = "awaiting database readiness";
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", container, "psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]);
      ready = true;
      break;
    } catch { await delay(500); }
  }
  if (!ready) throw new Error("database unavailable");
  phase = "creating vector extension";
  docker(["exec", container, "psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1",
    "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);
  const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${db}`;
  const env = { ...process.env, DATABASE_URL: url, ARCH043_API_TEST_DATABASE_URL: url };
  phase = "generating Prisma client";
  run("npx", ["--no-install", "prisma", "generate", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "deploying real migrations";
  run("npx", ["--no-install", "prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"],
    { env, stdio: "inherit" });
  phase = "running all four PostgreSQL service tests";
  const testOutput = run("node", ["--import", "tsx", "--test", "--test-reporter=tap",
    "tests/integration/platform-configuration/service.postgres.test.ts"], { env });
  // Node's structured TAP totals reject zero/partial/skipped runs (an exit code of 0 alone cannot).
  const has = (name, count) => new RegExp(`^# ${name}\\s+${count}\\s*$`, "m").test(testOutput);
  if (!has("tests", 4) || !has("pass", 4) || !has("fail", 0) || !has("skipped", 0)) {
    throw new Error("incomplete PostgreSQL test run");
  }
  process.stdout.write("ARCH-043-API-001 disposable PostgreSQL service tests PASS (4/4)\n");
} catch {
  // Do not emit the child exception; its arguments can include generated credentials.
  process.stderr.write(`ARCH-043-API-001 failed during ${phase}.\n`);
  process.exitCode = 1;
} finally {
  if (started) {
    try {
      docker(["rm", "--force", container]);
      process.stdout.write("ARCH-043-API-001 disposable PostgreSQL cleanup PASS\n");
    } catch {
      process.stderr.write("ARCH-043-API-001 disposable PostgreSQL cleanup FAILED\n");
      process.exitCode = 1;
    }
  }
}
