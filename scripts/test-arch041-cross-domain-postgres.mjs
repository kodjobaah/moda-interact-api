import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// The recovery-policy and webhook receipt suites need a disposable migration-backed
// database. Do not reuse the installation db-push harness.
const suffix = randomUUID().replaceAll("-", "");
const name = `moda-api-arch041-cross-domain-${suffix}`;
const database = `api_extra_${suffix.slice(0, 16)}`;
const user = `api_extra_${suffix.slice(16, 28)}`;
const password = randomUUID();
const suites = [
  "tests/integration/merchant/recovery-policy/service.postgres.test.ts",
  "tests/integration/woocommerce/billing/webhooks/webhook-receipt.service.postgres.test.ts",
];

let started = false;
let phase = "starting PostgreSQL";
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
  phase = "resolving the mapped PostgreSQL port";
  const mappedPort = docker(["port", name, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!mappedPort) throw new Error("disposable PostgreSQL port unavailable");
  phase = "checking PostgreSQL readiness";
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
  if (!ready) throw new Error("disposable PostgreSQL did not become ready");
  phase = "enabling pgvector";
  docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);

  const url = `postgresql://${user}:${password}@127.0.0.1:${mappedPort}/${database}`;
  const env = { ...process.env, DATABASE_URL: url, WOO_INSTALLATION_TEST_DATABASE_URL: url };
  // npm ci may omit dependency install scripts; a standalone runner must not
  // rely on another npm command having generated the current Prisma Client.
  phase = "generating the Prisma client";
  run("npx", ["--no-install", "prisma", "generate", "--schema", "database/prisma/schema.prisma"], {
    env, stdio: "inherit",
  });
  phase = "deploying Prisma migrations";
  run("npx", ["--no-install", "prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"], {
    env, stdio: "inherit",
  });
  phase = "running cross-domain PostgreSQL suites";
  run("node", ["--import", "tsx", "--test", "--test-concurrency=1", ...suites], {
    env, stdio: "inherit",
  });
} catch {
  // execFileSync exceptions can include the full Docker argv, including the
  // generated POSTGRES_PASSWORD. Never print that error object or its stack.
  process.stderr.write(`ARCH-041 cross-domain PostgreSQL validation failed while ${phase}.\n`);
  process.exitCode = 1;
} finally {
  if (started) {
    try {
      // Cleanup is required even when migrations or any suite fails.
      docker(["rm", "--force", name]);
    } catch {
      process.stderr.write("ARCH-041 cross-domain PostgreSQL container cleanup failed.\n");
      process.exitCode = 1;
    }
  }
}
