import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const name = `moda-api-arch035-activity-${randomUUID().replaceAll("-", "")}`;
let started = false;
let stage = "creating disposable Redis";
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" });
try {
  docker(["run", "--detach", "--rm", "--name", name,
    "--publish", "127.0.0.1::6379", "redis:7-alpine"]);
  started = true;
  stage = "checking Redis readiness";
  const port = docker(["port", name, "6379/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("Redis port unavailable");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if (docker(["exec", name, "redis-cli", "PING"]).trim() === "PONG") { ready = true; break; } }
    catch { /* readiness poll */ }
    await delay(250);
  }
  if (!ready) throw new Error("Redis not ready");
  stage = "running authenticated BullMQ integration tests";
  execFileSync("node", ["--import", "tsx", "--test", "--test-concurrency=1",
    "tests/integration/woocommerce/activity/redis-queue.test.ts"], {
    stdio: "inherit", timeout: 120_000,
    env: { ...process.env, WOO_ACTIVITY_TEST_REDIS_URL: `redis://127.0.0.1:${port}` },
  });
  process.stdout.write("PASS ARCH-035-API-008/019 disposable Redis/BullMQ checkout and order capture\n");
} catch {
  process.stderr.write(`ARCH-035-API-008 Redis integration failed while ${stage}.\n`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { docker(["rm", "--force", name]); }
    catch { process.stderr.write("ARCH-035-API-008 disposable Redis cleanup failed.\n"); process.exitCode = 1; }
  }
}
