import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// Disposable PostgreSQL rehearsal with the actual DATABASE-003 migration triggers.
const suffix = randomUUID().replaceAll("-", "");
const name = `moda-api-woo-read-${suffix}`;
const database = `woo_read_${suffix.slice(0, 16)}`;
const user = `woo_read_${suffix.slice(16, 28)}`;
const password = randomUUID();
let started = false;
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
const docker = (args, options) => run("docker", args, options);

try {
  docker([
    "run", "--detach", "--rm", "--name", name,
    "--env", `POSTGRES_DB=${database}`,
    "--env", `POSTGRES_USER=${user}`,
    "--env", `POSTGRES_PASSWORD=${password}`,
    "--publish", "127.0.0.1::5432",
    "pgvector/pgvector:pg17",
  ]);
  started = true;
  const mappedPort = docker(["port", name, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!mappedPort) throw new Error("disposable database port not available");
  const url = `postgresql://${user}:${password}@127.0.0.1:${mappedPort}/${database}`;
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]);
      ready = true;
      break;
    } catch {
      await delay(500);
    }
  }
  if (!ready) throw new Error("disposable PostgreSQL did not become ready in time");
  docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);
  const env = { ...process.env, DATABASE_URL: url, WOO_INSTALLATION_TEST_DATABASE_URL: url };
  // Do not substitute Prisma db push: the accepted migration contains replay and ownership triggers.
  run("npx", ["prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  run("node", ["--import", "tsx", "--test", "--test-concurrency=1", "src/woocommerce/rest-read/authorization.postgres.test.ts", "src/woocommerce/rest-read/provider-connection.postgres.test.ts"], {
    env, stdio: "inherit",
  });
} finally {
  if (started) docker(["rm", "--force", name]);
}
