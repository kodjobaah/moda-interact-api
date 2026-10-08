import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const suffix = randomUUID().replaceAll("-", "");
const containerName = `moda-api-woo-test-${suffix}`;
const databaseName = `woo_test_${suffix.slice(0, 16)}`;
const user = `woo_test_${suffix.slice(16, 28)}`;
const password = randomUUID();
let containerStarted = false;

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
}

function docker(args, options) {
  return run("docker", args, options);
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker([
        "exec", containerName, "psql", "-U", user, "-d", databaseName,
        "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1",
      ]);
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready within 30 seconds");
}

try {
  docker([
    "run", "--detach", "--rm", "--name", containerName,
    "--env", `POSTGRES_DB=${databaseName}`,
    "--env", `POSTGRES_USER=${user}`,
    "--env", `POSTGRES_PASSWORD=${password}`,
    "--publish", "127.0.0.1::5432",
    "pgvector/pgvector:pg17",
  ]);
  containerStarted = true;
  const portLine = docker(["port", containerName, "5432/tcp"]).trim();
  const portMatch = portLine.match(/:(\d+)$/);
  if (!portMatch) throw new Error("Docker did not report the mapped PostgreSQL port");
  const databaseUrl = `postgresql://${user}:${password}@127.0.0.1:${portMatch[1]}/${databaseName}`;
  await waitForPostgres();
  docker(["exec", containerName, "psql", "-U", user, "-d", databaseName, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION vector"]);

  const environment = { ...process.env, DATABASE_URL: databaseUrl };
  run("npx", ["prisma", "db", "push", "--schema", "database/prisma/schema.prisma", "--skip-generate", "--accept-data-loss"], {
    env: environment,
    stdio: "inherit",
  });
  run("node", ["--import", "tsx", "--test", "src/woocommerce/installation/connection-service.postgres.test.ts"], {
    env: { ...environment, WOO_INSTALLATION_TEST_DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  run("node", ["--import", "tsx", "--test", "src/merchant/bootstrap/bootstrap-read.service.postgres.test.ts"], {
    env: { ...environment, WOO_INSTALLATION_TEST_DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  run("node", ["--import", "tsx", "--test", "src/billing/presentation/billing-read.postgres.test.ts"], {
    env: { ...environment, WOO_INSTALLATION_TEST_DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
} finally {
  if (containerStarted) docker(["rm", "--force", containerName]);
}