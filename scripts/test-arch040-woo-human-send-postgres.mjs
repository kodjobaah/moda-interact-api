import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

/** API-owned disposable PostgreSQL proof. Never uses a shared development DB. */
if (!existsSync("database/prisma/migrations/20261018092000_arch040_moderation_template_content_digest/migration.sql")) {
  process.stderr.write("ARCH-040-API-004 requires accepted DATABASE-005 in the API database submodule.\n");
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
  phase = "running human send command and moderation tests";
  exec("node",["--import","tsx","--test","--test-concurrency=1",
    "tests/integration/merchant/conversations/messages.service.postgres.test.ts"],{env,stdio:"inherit"});
  process.stdout.write("PASS ARCH-040-API-004 disposable PostgreSQL admission suite\n");
} catch {
  process.stderr.write(`ARCH-040-API-004 PostgreSQL failed while ${phase}.\n`);
  process.exitCode = 1;
} finally {
  if (started) { try { docker(["rm","--force",container]); }
    catch { process.stderr.write("ARCH-040-API-004 PostgreSQL cleanup failed.\n"); process.exitCode=1; } }
}
