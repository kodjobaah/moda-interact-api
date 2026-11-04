import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// Separate disposable PostgreSQL per invocation, with the real migration-defined
// triggers and constraints. Do not use prisma db push for billing integrity proof.
const suffix = randomUUID().replaceAll("-", "");
const name = `moda-api-arch041-billing-${suffix}`;
const database = `arch041_${suffix.slice(0, 16)}`;
const user = `arch041_${suffix.slice(16, 28)}`;
const password = randomUUID();
const initialSuites = [
  "tests/integration/billing/presentation/billing-read.postgres.test.ts",
  "tests/integration/billing/purchase-history/arch055-history.postgres.test.ts",
  "tests/integration/billing/commands/recurring-subscription-command.postgres.test.ts",
  "tests/integration/billing/commands/recovery-credit-purchase-command.postgres.test.ts",
  "tests/integration/billing/commands/recurring-outcome.test.ts",
  "tests/integration/billing/commands/recovery-credit-outcome.test.ts",
  "tests/integration/billing/commands/arch055-installation-admission.postgres.test.ts",
];
const additionalSuites = process.argv.slice(2);
for (const file of additionalSuites) {
  if (!/^tests\/integration\/billing\/[A-Za-z0-9_./-]+\.test\.ts$/.test(file) || file.includes("..")) {
    throw new Error("Additional test paths must be within tests/integration/billing/ and end in .test.ts");
  }
}

let started = false;
let baselineDirectory;
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
  process.stdout.write("Disposable billing PostgreSQL: " + name + "\n");
  phase = "resolving the mapped PostgreSQL port";
  const mappedPort = docker(["port", name, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!mappedPort) throw new Error("disposable PostgreSQL port unavailable");
  phase = "checking PostgreSQL readiness";
  let ready = false;
  let readinessDiagnostic = "";
  for (let i = 0; i < 60; i += 1) {
    try {
      docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]);
      ready = true;
      break;
    } catch (error) {
      // stderr contains the psql/container failure, not execFileSync's argv.
      readinessDiagnostic = String(error?.stderr ?? "").replaceAll(password, "[REDACTED]").slice(0, 1024);
      await delay(500);
    }
  }
  if (!ready) {
    process.stderr.write("PostgreSQL readiness diagnostic: " + readinessDiagnostic + "\n");
    throw new Error("disposable PostgreSQL did not become ready");
  }
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
  if (process.env.ARCH055_COMMERCIAL_COMPARE_BASELINE === "1") {
    const measurementTest = initialSuites[1];
    const baselineRef = "fa2a857ed2ccfd629a7c9f2749ce4a38cc143ff0";
    phase = "preparing isolated ARCH-055 commercial baseline";
    baselineDirectory = mkdtempSync(join(tmpdir(), "moda-api006-paired-"));
    const archive = execFileSync("git", ["archive", baselineRef], { maxBuffer: 100 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", baselineDirectory], { input: archive });
    execFileSync("mkdir", ["-p", join(baselineDirectory, "tests/integration/billing/purchase-history")]);
    copyFileSync(measurementTest, join(baselineDirectory, measurementTest));
    symlinkSync(join(process.cwd(), "node_modules"), join(baselineDirectory, "node_modules"), "dir");
    // Identical canonical schema; isolated DBs prevent fixture growth in one
    // version contaminating the other's append-only accounting evidence.
    for (const version of ["candidate", "baseline"]) {
      docker(["exec", name, "psql", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
        `CREATE DATABASE "${database}_${version}" TEMPLATE "${database}"`]);
    }
    for (const version of ["candidate", "baseline"]) {
      const versionUrl = `postgresql://${user}:${password}@127.0.0.1:${mappedPort}/${database}_${version}`;
      phase = `measuring ARCH-055 commercial ${version}`;
      run("node", ["--import", "tsx", "--test", "--test-concurrency=1", "--test-name-pattern",
        "ARCH-055 commercial paired M11-M14 profiles", measurementTest], {
        cwd: version === "baseline" ? baselineDirectory : process.cwd(),
        env: { ...env, DATABASE_URL: versionUrl, WOO_INSTALLATION_TEST_DATABASE_URL: versionUrl,
          ARCH055_COMMERCIAL_VERSION: version }, stdio: "inherit",
      });
    }
  } else {
    phase = "running billing PostgreSQL suites";
    run("node", ["--import", "tsx", "--test", "--test-concurrency=1", ...initialSuites, ...additionalSuites], {
      env, stdio: "inherit",
    });
  }
} catch (error) {
  const diagnostic = String(error?.stderr ?? error?.code ?? "").replaceAll(password, "[REDACTED]").slice(0, 1024);
  if (diagnostic) process.stderr.write("Billing runner diagnostic: " + diagnostic + "\n");
  // execFileSync exceptions can include the full Docker argv, including the
  // generated POSTGRES_PASSWORD. Never print that error object or its stack.
  process.stderr.write(`ARCH-041 billing PostgreSQL validation failed while ${phase}.\n`);
  process.exitCode = 1;
} finally {
  if (baselineDirectory) rmSync(baselineDirectory, { recursive: true, force: true });
  if (started) {
    try {
      // Cleanup is required even when migrations or any suite fails.
      docker(["rm", "--force", name]);
    } catch {
      process.stderr.write("ARCH-041 billing PostgreSQL container cleanup failed.\n");
      process.exitCode = 1;
    }
  }
}
