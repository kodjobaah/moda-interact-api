import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const suffix = randomUUID().replaceAll("-", "");
const name = `moda-api-arch053-restore-${suffix}`;
const database = `restore_${suffix.slice(0, 14)}`;
const user = `woo_${suffix.slice(14, 26)}`;
const password = randomUUID();
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", stdio: "pipe", ...options,
});
const docker = args => run("docker", args);
let started = false;
let phase = "starting disposable PostgreSQL";
try {
  docker(["run", "--detach", "--rm", "--name", name,
    "--env", `POSTGRES_DB=${database}`, "--env", `POSTGRES_USER=${user}`,
    "--env", `POSTGRES_PASSWORD=${password}`, "--publish", "127.0.0.1::5432", "pgvector/pgvector:pg17"]);
  started = true;
  phase = "resolving PostgreSQL port";
  const port = docker(["port", name, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("PostgreSQL port unavailable");
  phase = "awaiting PostgreSQL";
  let ready = false;
  for (let index = 0; index < 60; index += 1) {
    try {
      docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]);
      ready = true;
      break;
    } catch { await delay(500); }
  }
  if (!ready) throw new Error("PostgreSQL not ready");
  const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  phase = "running resolver PostgreSQL integration suite";
  run("node", ["--import", "tsx", "--test", "--test-concurrency=1",
    "tests/integration/woocommerce/recovery-restore/service.postgres.test.ts"], {
    env: { ...process.env, ARCH053_WOO_RESTORE_TEST_DATABASE_URL: url }, stdio: "inherit",
  });
} catch {
  process.stderr.write(`ARCH-053 recovery restore PostgreSQL validation failed while ${phase}.\n`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { docker(["rm", "--force", name]); }
    catch { process.stderr.write("ARCH-053 recovery restore PostgreSQL cleanup failed.\n"); process.exitCode = 1; }
  }
}