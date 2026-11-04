import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import type { ReadinessDatabase } from "../../../src/database.js";
import { loadRuntimeConfig } from "../../../src/runtime-config.js";
import {
  createApiRuntime,
  registerShutdownHandlers,
} from "../../../src/server.js";

function barrier() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

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
test("24 timed-out HTTP observers retain one underlying probe until it settles", async () => {
  const held = barrier();
  let calls = 0;
  await withServer(createDatabase(() => ++calls === 1 ? held.promise : Promise.resolve()), async origin => {
    const status = async (path: string) => {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
      await response.text();
      return response.status;
    };
    try {
      const responses = await Promise.all(Array.from({ length: 24 }, () => status("/health/ready")));
      assert.deepEqual(responses, Array(24).fill(503));
      assert.equal(calls, 1);
      assert.equal(await status("/health/live"), 200);
      assert.equal(await status("/health/ready"), 503);
      assert.equal(calls, 1);
    } finally {
      held.resolve();
    }
    assert.equal(await status("/health/ready"), 200);
    assert.equal(await status("/health/ready"), 200);
    assert.equal(calls, 3);
  }, 50);
});

test("shutdown disconnects once after the HTTP deadline with the delegate still pending", async () => {
  const held = barrier();
  let disconnected = 0;
  const runtime = createApiRuntime({
    ...loadRuntimeConfig({ DATABASE_URL: "postgresql://localhost/moda" }),
    port: 0, readinessTimeoutMs: 25,
  }, {
    probe: () => held.promise,
    async disconnect() {
      disconnected++;
      held.resolve();
    },
  }, logger);
  await runtime.start();
  try {
    const address = runtime.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 503);
    await response.text();
    assert.equal(disconnected, 0);
  } finally {
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
  }
  assert.equal(disconnected, 1);
});

test("readiness diagnostics keep the original code and cause with URLs redacted", async () => {
  const records: unknown[] = [];
  const failure = Object.assign(new Error("Could not connect to postgresql://user:private@localhost/moda", {
    cause: new Error("socket closed"),
  }), { code: "P1001" });
  const runtime = createApiRuntime({
    ...loadRuntimeConfig({ DATABASE_URL: "postgresql://localhost/moda" }), port: 0,
  }, createDatabase(async () => { throw failure; }), createLogger({
    serviceName: "readiness-test", environment: "test", sink: record => records.push(record),
  }));
  await runtime.start();
  try {
    const address = runtime.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
    const diagnostics = JSON.stringify(records);
    assert.match(diagnostics, /P1001/);
    assert.match(diagnostics, /socket closed/);
    assert.match(diagnostics, /Could not connect/);
    assert.doesNotMatch(diagnostics, /private|postgresql:\/\//);
  } finally {
    await runtime.shutdown();
  }
});

test("M17 compares bounded fake delegates over real HTTP", {
  skip: !process.env.ARCH055_READINESS_MEASURE_VERSION,
}, async () => {
  const version = process.env.ARCH055_READINESS_MEASURE_VERSION;
  const source = process.env.ARCH055_READINESS_SOURCE_ROOT;
  const createRuntime = source
    ? (await import(pathToFileURL(resolve(source, "src/server.ts")).href) as typeof import("../../../src/server.js")).createApiRuntime
    : createApiRuntime;
  const config = { ...loadRuntimeConfig({ DATABASE_URL: "postgresql://localhost/moda" }), port: 0 };
  assert.equal(config.readinessTimeoutMs, 2000);
  for (const scenario of ["release-before-deadline", "held-through-deadline"]) {
    const samples: Record<string, unknown>[] = [];
    for (let iteration = 0; iteration < 7; iteration++) {
      const held = barrier();
      const arrived = barrier();
      let requests = 0;
      let probes = 0;
      let pending = 0;
      let peak = 0;
      const runtime = createRuntime(config, createDatabase(async () => {
        probes++;
        peak = Math.max(peak, ++pending);
        try { await held.promise; } finally { pending--; }
      }), logger);
      runtime.server.prependListener("request", () => {
        if (++requests === 20) arrived.resolve();
      });
      await runtime.start();
      const address = runtime.server.address();
      assert.ok(address && typeof address !== "string");
      const start = performance.now();
      const observers = Promise.all(Array.from({ length: 20 }, async () => {
        const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`, {
          signal: AbortSignal.timeout(5000),
        });
        await response.text();
        return response.status;
      }));
      try {
        if (scenario === "release-before-deadline") {
          await Promise.race([arrived.promise, observers]);
          assert.equal(requests, 20);
          held.resolve();
        }
        const statuses = await observers;
        const elapsedMs = performance.now() - start;
        const expectedStatus = scenario === "held-through-deadline" ? 503 : 200;
        assert.deepEqual(statuses, Array(20).fill(expectedStatus));
        assert.equal(probes, version === "baseline" ? 20 : 1);
        assert.equal(peak, probes);
        assert.equal(pending, expectedStatus === 503 ? probes : 0);
        if (iteration >= 2) samples.push({ requests, probes, peak, pending, elapsedMs, status: expectedStatus,
          sql: "not applicable to fake delegate", affectedRows: 0 });
      } finally {
        held.resolve();
        await runtime.shutdown();
      }
    }
    console.log(JSON.stringify({ profile: "M17", version, scenario, warmups: 2, samples }));
  }
});
