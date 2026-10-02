import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import type { ReadinessDatabase } from "./database.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import {
  createApiRuntime,
  registerShutdownHandlers,
} from "./server.js";

const logger = createLogger({
  serviceName: "moda-interact-api-test",
  environment: "test",
  sink: () => undefined,
});

function createDatabase(
  probe: () => Promise<void> = async () => undefined,
): ReadinessDatabase & { disconnectCount: () => number } {
  let disconnectCount = 0;
  return {
    probe,
    async disconnect() {
      disconnectCount += 1;
    },
    disconnectCount: () => disconnectCount,
  };
}

async function withServer(
  database: ReadinessDatabase,
  callback: (baseUrl: string) => Promise<void>,
  readinessTimeoutMs = 100,
): Promise<void> {
  const config = {
    ...loadRuntimeConfig({ DATABASE_URL: "postgresql://user:secret@localhost:5432/moda" }),
    port: 0,
    readinessTimeoutMs,
  };
  const runtime = createApiRuntime(config, database, logger);
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await runtime.shutdown();
  }
}

test("liveness succeeds without probing PostgreSQL", async () => {
  let probeCount = 0;
  await withServer(
    createDatabase(async () => {
      probeCount += 1;
      throw new Error("database unavailable");
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health/live`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
    },
  );
  assert.equal(probeCount, 0);
});

test("readiness reports database success and failure with bounded JSON", async () => {
  await withServer(createDatabase(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ready" });
  });

  await withServer(
    createDatabase(async () => {
      throw new Error("postgresql://user:private-secret@host/db");
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health/ready`);
      const body = await response.text();
      assert.equal(response.status, 503);
      assert.equal(body, '{"status":"not_ready"}');
      assert.doesNotMatch(body, /private-secret/);
    },
  );
});

test("readiness returns 503 after the probe deadline", async () => {
  await withServer(
    createDatabase(() => new Promise<void>(() => undefined)),
    async (baseUrl) => {
      const startedAt = Date.now();
      const response = await fetch(`${baseUrl}/health/ready`);
      assert.equal(response.status, 503);
      assert.ok(Date.now() - startedAt < 1000);
    },
    20,
  );
});

test("unknown routes return a bounded 404 without database access", async () => {
  let probeCount = 0;
  await withServer(
    createDatabase(async () => {
      probeCount += 1;
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/shops`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_found" });
    },
  );
  assert.equal(probeCount, 0);
});

test("startup and shutdown are idempotent and signals close Prisma once", async () => {
  const database = createDatabase();
  const config = {
    ...loadRuntimeConfig({ DATABASE_URL: "postgresql://user:secret@localhost:5432/moda" }),
    port: 0,
  };
  const runtime = createApiRuntime(config, database, logger);
  const signalSource = new EventEmitter();
  let shutdownFailureCount = 0;

  await Promise.all([runtime.start(), runtime.start()]);
  registerShutdownHandlers(
    runtime,
    signalSource as unknown as Parameters<typeof registerShutdownHandlers>[1],
    () => {
      shutdownFailureCount += 1;
    },
  );
  signalSource.emit("SIGTERM");
  await runtime.shutdown();
  signalSource.emit("SIGINT");

  assert.equal(database.disconnectCount(), 1);
  assert.equal(shutdownFailureCount, 0);
  assert.equal(runtime.server.listening, false);
});