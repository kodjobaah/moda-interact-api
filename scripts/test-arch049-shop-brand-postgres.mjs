import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// Disposable PostgreSQL only; never point integration tests at merchant data.
// Requires the accepted ARCH-049-DATABASE-001 submodule and its migration.
const suffix = randomUUID().replaceAll("-", "");
const name = `moda-api-arch049-brand-${suffix}`;
const database = `shopbrand_${suffix.slice(0, 14)}`;
const user = `woo_${suffix.slice(14, 26)}`;
const password = randomUUID();
const run = (cmd, args, options = {}) => execFileSync(cmd, args, {
  encoding: "utf8", stdio: "pipe", ...options,
});
const docker = args => run("docker", args);
let started = false;
let phase = "checking accepted ARCH-049 database schema";
try {
  const schema = readFileSync("database/prisma/schema.prisma", "utf8");
  const brand = schema.match(/model ShopBrand \{[\s\S]*?\n\}/)?.[0] ?? "";
  if (!brand.includes("whatsAppMedia") || !brand.includes('@@schema("commerce")')) {
    throw new Error("ARCH-049 schema missing");
  }
  readFileSync("database/prisma/migrations/20261025170000_arch049_shopbrand_commerce_media/migration.sql");
  phase = "starting disposable PostgreSQL";
  docker(["run", "--detach", "--rm", "--name", name,
    "--env", `POSTGRES_DB=${database}`, "--env", `POSTGRES_USER=${user}`,
    "--env", `POSTGRES_PASSWORD=${password}`, "--publish", "127.0.0.1::5432", "pgvector/pgvector:pg17"]);
  started = true;
  phase = "resolving PostgreSQL port";
  const port = docker(["port", name, "5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("PostgreSQL port unavailable");
  phase = "awaiting PostgreSQL";
  let ready = false;
  for (let index = 0; index < 60; index++) {
    try { docker(["exec", name, "psql", "-U", user, "-d", database,
      "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]); ready = true; break; }
    catch { await delay(500); }
  }
  if (!ready) throw new Error("PostgreSQL not ready");
  phase = "enabling pgvector";
  docker(["exec", name, "psql", "-U", user, "-d", database,
    "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);
  const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  const env = { ...process.env, DATABASE_URL: url, WOO_SHOP_BRAND_TEST_DATABASE_URL: url };
  phase = "generating Prisma client";
  run("npx", ["--no-install", "prisma", "generate", "--schema", "database/prisma/schema.prisma"],
    { env, stdio: "inherit" });
  phase = "applying canonical migrations";
  run("npx", ["--no-install", "prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"],
    { env, stdio: "inherit" });
  phase = "running ShopBrand PostgreSQL integration suite";
  run("node", ["--import", "tsx", "--test", "--test-concurrency=1",
    "tests/integration/woocommerce/shop-brand/service.postgres.test.ts"], { env, stdio: "inherit" });
} catch {
  // Do not print exceptions/argv: they can include disposable DB credentials.
  process.stderr.write(`ARCH-049 ShopBrand PostgreSQL validation failed while ${phase}.\n`);
  if (phase === "checking accepted ARCH-049 database schema") {
    process.stderr.write("Update API's database submodule to accepted ARCH-049-DATABASE-001 and regenerate Prisma; do not use db push.\n");
  }
  process.exitCode = 1;
} finally {
  if (started) {
    try { docker(["rm", "--force", name]); }
    catch { process.stderr.write("ARCH-049 ShopBrand PostgreSQL cleanup failed.\n"); process.exitCode = 1; }
  }
}
