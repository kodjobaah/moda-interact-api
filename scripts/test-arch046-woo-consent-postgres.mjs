import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// This runner requires the API implementation worktree's database submodule to
// point at the architect-accepted ARCH-045-DATABASE-002 migration before running.
const suffix = randomUUID().replaceAll("-", "");
const name = `moda-api-arch046-consent-${suffix}`;
const database = `woo_consent_${suffix.slice(0, 14)}`;
const user = `woo_${suffix.slice(16, 28)}`;
const password = randomUUID();
let started = false;
let baselineDirectory = null;
let phase = "verifying ARCH-045-DATABASE-002 schema dependency";
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
const docker = args => run("docker", args);
try {
  // The API uses the database submodule; a stale gitlink can successfully
  // deploy older migrations but does not create the required evidence table.
  const schema = readFileSync("database/prisma/schema.prisma", "utf8");
  if (!schema.includes("model WhatsAppConsentEvidence") ||
    !schema.includes("whatsappConsentDecisionSequence")) {
    throw new Error("ARCH-045 consent schema not present");
  }
  phase = "starting PostgreSQL";
  docker(["run", "--detach", "--rm", "--name", name,
    "--env", `POSTGRES_DB=${database}`, "--env", `POSTGRES_USER=${user}`,
    "--env", `POSTGRES_PASSWORD=${password}`, "--publish", "127.0.0.1::5432", "pgvector/pgvector:pg17"]);
  started = true;
  phase = "resolving PostgreSQL port";
  const port = docker(["port", name, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("PostgreSQL port unavailable");
  phase = "checking PostgreSQL readiness";
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]); ready = true; break; }
    catch { await delay(500); }
  }
  if (!ready) throw new Error("PostgreSQL not ready");
  phase = "enabling pgvector";
  docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);
  const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  const env = { ...process.env, DATABASE_URL: url, WOO_CONSENT_TEST_DATABASE_URL: url };
  phase = "generating Prisma Client";
  run("npx", ["--no-install", "prisma", "generate", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "deploying migrations";
  run("npx", ["--no-install", "prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"], { env, stdio: "inherit" });
  phase = "verifying ARCH-045-DATABASE-002 migration";
  docker(["exec", name, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c",
    "SELECT 1 FROM \"commerce\".\"WhatsAppConsentEvidence\" LIMIT 1"]);
  phase = "running Woo consent API integration suite";
  run("node", ["--import", "tsx", "--test", "--test-concurrency=1",
    "tests/integration/woocommerce/consent/service.postgres.test.ts",
    "tests/integration/woocommerce/consent/races.postgres.test.ts",
    "tests/integration/woocommerce/consent/v2.postgres.test.ts",
    "tests/integration/woocommerce/recovery-selection/service.postgres.test.ts"], { env, stdio: "inherit" });

  // Explicit opt-in: run the same independent performance scenario against the
  // pinned pre-API-007 service (v1) and the current v2 service. Both use this
  // disposable migrated PostgreSQL and identical setup. Do not duplicate v1
  // application code inside the v2 product or current production tests.
  if (process.env.ARCH046_CONSENT_COMPARE_BASELINE === "1") {
    phase = "preparing isolated pre-API-007 comparison";
    const baselineRef = process.env.ARCH046_CONSENT_BASELINE_REF || "220fa2b^";
    const original = resolve(process.cwd());
    const nodeModules = join(original, "node_modules");
    if (!existsSync(nodeModules)) throw new Error("Installed API node_modules required for benchmark");
    baselineDirectory = mkdtempSync(join(tmpdir(), "moda-api007-baseline-"));
    const archive = execFileSync("git", ["archive", baselineRef], { maxBuffer: 100 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", baselineDirectory], { input: archive });
    const performanceTest = "tests/integration/woocommerce/consent/performance.postgres.test.ts";
    mkdirSync(join(baselineDirectory, "tests/integration/woocommerce/consent"), { recursive: true });
    copyFileSync(join(original, performanceTest), join(baselineDirectory, performanceTest));
    symlinkSync(nodeModules, join(baselineDirectory, "node_modules"), "dir");
    if (!readFileSync(join(baselineDirectory, "src/woocommerce/consent/contract.ts"), "utf8")
      .includes('woo.whatsapp-consent.v1')) {
      throw new Error("Selected baseline does not contain the pre-change v1 consent API");
    }
    phase = "measuring pre-API-007 v1 baseline";
    run("node", ["--import", "tsx", "--test", performanceTest], {
      cwd: baselineDirectory, env: { ...env, ARCH046_CONSENT_BENCH_VERSION: "v1" }, stdio: "inherit",
    });
    phase = "measuring API-007 v2 implementation";
    run("node", ["--import", "tsx", "--test", performanceTest], {
      cwd: original, env: { ...env, ARCH046_CONSENT_BENCH_VERSION: "v2" }, stdio: "inherit",
    });
  }
} catch {
  // Do not print process errors: Docker args and database URLs contain secrets.
  process.stderr.write(`ARCH-046 Woo consent PostgreSQL validation failed while ${phase}.\n`);
  if (phase === "verifying ARCH-045-DATABASE-002 schema dependency") {
    process.stderr.write("Synchronize the API database submodule to the accepted ARCH-045-DATABASE-002 commit; do not use prisma db push.\n");
  }
  process.exitCode = 1;
} finally {
  if (baselineDirectory) rmSync(baselineDirectory, { recursive: true, force: true });
  if (started) {
    try { docker(["rm", "--force", name]); }
    catch { process.stderr.write("ARCH-046 Woo consent PostgreSQL cleanup failed.\n"); process.exitCode = 1; }
  }
}
