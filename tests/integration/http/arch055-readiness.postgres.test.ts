import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createDatabase, createReadinessClient } from "../../../src/database.js";
import { loadRuntimeConfig } from "../../../src/runtime-config.js";
import { createApiRuntime } from "../../../src/server.js";

function barrier() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const url = process.env.ARCH055_READINESS_TEST_DATABASE_URL;
const logger = createLogger({ serviceName: "readiness-test", environment: "test", sink() {} });

test("real readiness pool acquisition and query execution settle within five seconds", { skip: !url, timeout: 25_000 }, async () => {
  assert.ok(url);
  const tagged = new URL(url);
  const tag = "api-readiness-" + randomUUID();
  tagged.searchParams.set("application_name", tag);
  const readiness = createReadinessClient(tagged.toString());
  const observer = new PrismaClient({ datasources: { db: { url } } });
  const acquired = barrier();
  const release = barrier();
  const holding = readiness.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1`;
    acquired.resolve();
    await release.promise;
  }, { timeout: 10_000 });
  try {
    await Promise.race([acquired.promise, holding]);
    const sessions = await observer.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = ${tag}
    `;
    assert.equal(sessions[0]?.count, 1);
    const acquireStart = performance.now();
    await assert.rejects(readiness.$queryRaw`SELECT 1`, { code: "P2024" });
    const acquireMs = performance.now() - acquireStart;
    assert.ok(acquireMs < 5000, "pool acquisition did not settle within the safety ceiling");
    release.resolve();
    await holding;
    const queryStart = performance.now();
    await assert.rejects(readiness.$queryRaw`SELECT 1 FROM pg_sleep(8)`);
    const queryMs = performance.now() - queryStart;
    assert.ok(queryMs < 5000, "blocked query did not settle within the safety ceiling");
    // Socket timeout bounds the client promise. PostgreSQL may still be
    // finishing the deliberately blocked test statement on that connection.
    const recoveryDeadline = performance.now() + 10_000;
    while (true) {
      const active = await observer.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE application_name = ${tag} AND state = 'active'
      `;
      if (active[0]?.count === 0) break;
      assert.ok(performance.now() < recoveryDeadline, "test query did not finish on PostgreSQL");
      await delay(25);
    }
    const backendRecoveryMs = performance.now() - queryStart;
    await readiness.$queryRaw`SELECT 1`;
    console.log(JSON.stringify({ profile: "readiness-pool-and-socket", acquireMs, queryMs, backendRecoveryMs,
      physicalConnections: sessions[0]?.count, probeSql: "SELECT 1", affectedRows: 0 }));
  } finally {
    release.resolve();
    await holding.catch(() => undefined);
    await Promise.all([readiness.$disconnect(), observer.$disconnect()]);
  }
});

test("real HTTP readiness recovers after a network outage while the business pool stays live", { skip: !url, timeout: 25_000 }, async () => {
  assert.ok(url);
  const upstream = new URL(url);
  const upstreamPort = Number(upstream.port);
  let available = true;
  const sockets = new Set<Socket>();
  const proxy = createServer(incoming => {
    if (!available) {
      sockets.add(incoming);
      incoming.on("error", () => incoming.destroy());
      incoming.on("close", () => sockets.delete(incoming));
      // Read the stalled handshake bytes so the test proxy can observe EOF.
      incoming.resume();
      return;
    }
    const outgoing = connect(upstreamPort, upstream.hostname);
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        sockets.delete(socket);
        incoming.destroy();
        outgoing.destroy();
      });
    }
    incoming.pipe(outgoing).pipe(incoming);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  upstream.port = String(address.port);
  const database = createDatabase(upstream.toString());
  let probes = 0;
  let latestProbe: Promise<void> | undefined;
  const runtime = createApiRuntime({ ...loadRuntimeConfig({ DATABASE_URL: url }), port: 0 }, {
    probe() { probes++; return latestProbe = database.probe(); },
    disconnect: () => database.disconnect(),
  }, logger);
  try {
    await runtime.start();
    const http = runtime.server.address();
    assert.ok(http && typeof http !== "string");
    const status = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${http.port}/health/${path}`, { signal: AbortSignal.timeout(5000) });
      return [response.status, await response.json()];
    };
    const pid = () => database.prisma.$queryRaw`SELECT pg_backend_pid() AS pid`;
    const before = await pid();
    const businessSockets = new Set(sockets);
    assert.deepEqual(await status("ready"), [200, { status: "ready" }]);
    // Drop the readiness connection and stall new handshakes.
    available = false;
    for (const socket of sockets) if (!businessSockets.has(socket)) socket.destroy();
    const start = performance.now();
    assert.deepEqual(await status("ready"), [503, { status: "not_ready" }]);
    const outageMs = performance.now() - start;
    const connectStart = performance.now();
    assert.deepEqual(await status("ready"), [503, { status: "not_ready" }]);
    assert.ok(latestProbe);
    await assert.rejects(latestProbe);
    const stalledHandshakeMs = performance.now() - connectStart;
    assert.ok(stalledHandshakeMs < 5000);
    const beforeLive = probes;
    assert.deepEqual(await status("live"), [200, { status: "ok" }]);
    assert.equal(probes, beforeLive);
    assert.deepEqual(await pid(), before);
    available = true;
    assert.deepEqual(await status("ready"), [200, { status: "ready" }]);
    assert.deepEqual(await pid(), before);
    assert.ok(outageMs < 5000);
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    const cleanupDeadline = performance.now() + 5000;
    while (sockets.size) {
      assert.ok(performance.now() < cleanupDeadline, "shutdown did not close both database transports");
      await delay(25);
    }
    console.log(JSON.stringify({ profile: "readiness-http-outage", outageMs, stalledHandshakeMs,
      liveProbes: 0, recovered: true, socketsAfterShutdown: sockets.size }));
  } finally {
    await runtime.shutdown();
    await runtime.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
