import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--recovery-defaults-only")) {
  throw new Error("Usage: node scripts/test-arch055-installation-postgres.mjs [--recovery-defaults-only]");
}
const recoveryDefaultsOnly = args[0] === "--recovery-defaults-only";
const recoveryDefaultsTest = "tests/integration/woocommerce/installation/recovery-defaults.postgres.test.ts";
const tests = recoveryDefaultsOnly ? [recoveryDefaultsTest] : [
  "tests/integration/woocommerce/installation/connection-service.postgres.test.ts",
  "tests/integration/woocommerce/installation/arch055-principal-races.postgres.test.ts",
  recoveryDefaultsTest,
];

const suffix = randomUUID().replaceAll("-", "");
const name = `moda-api-arch055-install-${suffix}`;
const database = `arch055_${suffix.slice(0, 16)}`;
const user = `arch055_${suffix.slice(16, 28)}`;
const password = randomUUID();
let started = false;
let phase = "starting disposable PostgreSQL";

const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", stdio: "pipe", ...options,
});
const docker = (args, options) => run("docker", args, options);

try {
  docker([
    "run", "--detach", "--rm", "--name", name,
    "--env", `POSTGRES_DB=${database}`,
    "--env", `POSTGRES_USER=${user}`,
    "--env", `POSTGRES_PASSWORD=${password}`,
    "--publish", "127.0.0.1::5432", "pgvector/pgvector:pg17",
  ]);
  started = true;
  phase = "resolving PostgreSQL port";
  const port = docker(["port", name, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("PostgreSQL port unavailable");
  phase = "waiting for PostgreSQL";
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", "-e", `PGPASSWORD=${password}`, name, "psql", "-h", "127.0.0.1", "-U", user, "-d", database,
        "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]);
      ready = true;
      break;
    } catch {
      await delay(500);
    }
  }
  if (!ready) throw new Error("PostgreSQL not ready");
  docker(["exec", "-e", `PGPASSWORD=${password}`, name, "psql", "-h", "127.0.0.1", "-U", user, "-d", database,
    "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);
  const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  const env = { ...process.env, DATABASE_URL: url, WOO_INSTALLATION_TEST_DATABASE_URL: url };
  phase = "generating Prisma Client";
  run("npx", ["--no-install", "prisma", "generate", "--schema", "database/prisma/schema.prisma"], {
    env, stdio: "inherit",
  });
  phase = "deploying canonical migrations";
  run("npx", ["--no-install", "prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"], {
    env, stdio: "inherit",
  });
  phase = "running installation PostgreSQL suites";
  run("node", ["--import", "tsx", "--test", "--test-concurrency=1", ...tests], {
    env, stdio: "inherit",
  });
} catch (error) {
  process.stderr.write(`ARCH-055 installation PostgreSQL validation failed while ${phase}.\n`);
  process.stderr.write(`Command failure: status=${error?.status ?? "unknown"}, code=${error?.code ?? "unknown"}, signal=${error?.signal ?? "none"}\n`);
  // Only inspect the disposable container owned by this invocation, before
  // cleanup. Keep diagnostics bounded and avoid printing connection strings.
  if (started) {
    for (const args of [
      ["inspect", "--format", "status={{.State.Status}} oomKilled={{.State.OOMKilled}} exitCode={{.State.ExitCode}}", name],
      ["logs", "--tail", "60", name],
    ]) {
      try {
        docker(args, { stdio: "inherit", timeout: 10_000 });
      } catch (diagnosticError) {
        process.stderr.write(`Disposable PostgreSQL ${args[0]} diagnostic failed: ${diagnosticError?.code ?? "unknown"}\n`);
      }
    }
  }
  process.exitCode = 1;
} finally {
  if (started) {
    try {
      docker(["rm", "--force", name]);
    } catch {
      process.stderr.write("ARCH-055 installation PostgreSQL container cleanup failed.\n");
      process.exitCode = 1;
    }
  }
}