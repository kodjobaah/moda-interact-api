import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

/** API-owned disposable PostgreSQL proof. Never uses a shared development DB. */
if (!existsSync("database/prisma/migrations/20261018092000_arch040_moderation_template_content_digest/migration.sql")) {
  process.stderr.write("ARCH-040-API-004 requires accepted DATABASE-005 in the API database submodule.\n");
  process.exit(1);
}
// ARCH-047 requires accepted canonical migrations. The API's pinned database
// submodule may be older, and isolated task worktrees need not have a sibling
// database repository. Never copy migrations into API or use a shared database.
// Prefer the API submodule when already updated; otherwise use the sibling
// canonical repository or an explicitly supplied read-only schema path.
const apiSchema = "database/prisma/schema.prisma";
const acceptedMigration = "20261024133000_arch047_template_persistence";
const configuredSchema = process.env.ARCH047_CANONICAL_DATABASE_SCHEMA;
const candidates = configuredSchema
  ? [configuredSchema]
  : [apiSchema, "../moda-interact-database/prisma/schema.prisma"];
const canonicalSchema = candidates.find((schema) => existsSync(schema) &&
  existsSync(join(dirname(schema), "migrations", acceptedMigration, "migration.sql")));
if (!canonicalSchema) {
  process.stderr.write("ARCH-047-API-001 needs the accepted canonical ARCH-047 schema and migration. " +
    "Update the API database submodule or set ARCH047_CANONICAL_DATABASE_SCHEMA to the approved schema.prisma path.\n");
  process.exit(1);
}
const salt = randomUUID().replaceAll("-", "");
const container = `moda-api-arch040-send-${salt}`;
const database = `send_${salt.slice(0,16)}`;
const user = `send_${salt.slice(16,28)}`;
const password = randomUUID();
const exec = (binary, args, options = {}) => execFileSync(binary,args,{ encoding: "utf8", stdio:"pipe",...options });
const docker = (args) => exec("docker",args);
let started = false;
let phase = "starting disposable PostgreSQL";
try {
  docker(["run","--detach","--rm","--name",container,"--env",`POSTGRES_DB=${database}`,
    "--env",`POSTGRES_USER=${user}`,"--env",`POSTGRES_PASSWORD=${password}`,
    "--publish","127.0.0.1::5432","pgvector/pgvector:pg17"]);
  started = true;
  phase = "resolving disposable PostgreSQL port";
  const port = docker(["port",container,"5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("port missing");
  phase = "waiting for PostgreSQL final TCP listener";
  let ready = false;
  for (let i=0;i<60;i++) {
    try { docker(["exec",container,"pg_isready","-h","127.0.0.1","-U",user,"-d",database]); ready=true; break; }
    catch { await delay(500); }
  }
  if (!ready) throw new Error("database not ready");
  phase = "enabling pgvector";
  docker(["exec",container,"psql","-U",user,"-d",database,"-v","ON_ERROR_STOP=1","-c","CREATE EXTENSION IF NOT EXISTS vector"]);
  const env = { ...process.env, DATABASE_URL: `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`,
    WOO_INSTALLATION_TEST_DATABASE_URL: `postgresql://${user}:${password}@127.0.0.1:${port}/${database}` };
  phase = "generating Prisma Client";
  exec("npx",["--no-install","prisma","generate","--schema","database/prisma/schema.prisma"],{env,stdio:"inherit"});
  phase = "deploying accepted database migrations";
  exec("npx",["--no-install","prisma","migrate","deploy","--schema","database/prisma/schema.prisma"],{env,stdio:"inherit"});
  if (resolve(canonicalSchema) !== resolve(apiSchema)) {
    phase = "deploying accepted canonical ARCH-047 migrations";
    exec("npx",["--no-install","prisma","migrate","deploy","--schema",canonicalSchema],{env,stdio:"inherit"});
  }
  phase = "running HUMAN send and ARCH-047 linked template eligibility tests";
  exec("node",["--import","tsx","--test","--test-concurrency=1",
    "tests/integration/merchant/conversations/messages.service.postgres.test.ts",
    "tests/integration/merchant/conversations/messages.follow-up-policy.postgres.test.ts",
    "tests/integration/merchant/conversations/messages.follow-up-catalogue.postgres.test.ts",
    "tests/integration/merchant/recoveries/detail/enriched-detail.postgres.test.ts"],{env,stdio:"inherit"});
  process.stdout.write("PASS ARCH-040/ARCH-047 disposable PostgreSQL read and admission suites\n");
} catch {
  process.stderr.write(`ARCH-040-API-004/API-005 PostgreSQL failed while ${phase}.\n`);
  process.exitCode = 1;
} finally {
  if (started) { try { docker(["rm","--force",container]); }
    catch { process.stderr.write("ARCH-040-API-004 PostgreSQL cleanup failed.\n"); process.exitCode=1; } }
}
