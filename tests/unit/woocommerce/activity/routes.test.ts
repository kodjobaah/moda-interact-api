import assert from "node:assert/strict";
import test from "node:test";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../../../src/auth/woo-installation/authenticator.js";
import { createWooCheckoutActivityRoute } from "../../../../src/woocommerce/activity/routes.js";
import type { WooCheckoutPublisher } from "../../../../src/woocommerce/activity/producer.js";
import type { WooOrderPublisher } from "../../../../src/woocommerce/activity/order-producer.js";
import { WooCheckoutReplayConflict } from "../../../../src/woocommerce/activity/producer.js";
import { createApiRuntime } from "../../../../src/server.js";
import { event } from "../../../fixtures/woocommerce/activity/checkout-event.js";
import { orderPlaced, orderPaid, orderCancelled } from "../../../fixtures/woocommerce/activity/order-event.js";

async function withRoute(options: {
  authenticate?: () => Promise<{ shopId: string; installationId: string; canonicalSiteUrl: string; credentialVersion: number }>;
  publish?: WooCheckoutPublisher["publish"];
  orderPublish?: WooOrderPublisher["publish"];
  disableOrderPublisher?: boolean;
} = {}, callback: (origin: string, calls: { auth: number; publish: number; orderPublish: number; logs: unknown[] }) => Promise<void>) {
  const calls = { auth: 0, publish: 0, orderPublish: 0, logs: [] as unknown[] };
  const authenticator = { async authenticate() {
    calls.auth++;
    return options.authenticate ? options.authenticate() : {
      shopId: "server-shop", installationId: "server-install", canonicalSiteUrl: "https://woo.example", credentialVersion: 1,
    };
  } } satisfies Pick<WooInstallationAuthenticator, "authenticate">;
  const publisher: WooCheckoutPublisher = { async publish(shopId, checkout) {
    calls.publish++;
    return options.publish ? options.publish(shopId, checkout) : { duplicate: false, jobId: "opaque" };
  } };
  const logger = { info(...args: unknown[]) { calls.logs.push(args); },
    warn(...args: unknown[]) { calls.logs.push(args); }, error(...args: unknown[]) { calls.logs.push(args); } } as StructuredLogger;
  const orderPublisher: WooOrderPublisher = { async publish(shopId, order) {
    calls.orderPublish++;
    return options.orderPublish ? options.orderPublish(shopId, order) : { duplicate: false, jobId: "order-opaque" };
  } };
  const handler = createWooCheckoutActivityRoute({
    authenticator, publisher, ...(options.disableOrderPublisher ? {} : { orderPublisher }), logger,
  });
  const runtime = createApiRuntime({
    databaseUrl: "postgresql://unused:unused@localhost/db", host: "0.0.0.0", port: 0,
    environment: "test", readinessTimeoutMs: 200, woocommerceConnectionMode: "public", wooBilling: null,
  }, { async probe() {}, async disconnect() {} }, logger, [handler]);
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try { await callback(`http://127.0.0.1:${address.port}`, calls); }
  finally { await runtime.shutdown(); }
}
const headers = { "content-type": "application/json" };
const send = (origin: string, body: unknown = event, path = "/v1/woocommerce/activity") =>
  fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

test("authenticated shop identity, no-store 202 and no payload/PII logging", async () => {
  await withRoute({ publish: async (shopId, checkout) => {
    assert.equal(shopId, "server-shop");
    assert.equal(checkout.eventId, "evt-001");
    return { duplicate: false, jobId: "opaque" };
  } }, async (origin, calls) => {
    const response = await send(origin, { ...event, checkout: {
      ...event.checkout, contact: { phone: "+447777777777", email: "client@example.org" },
    } });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "accepted" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(calls.publish, 1);
    const logged = JSON.stringify(calls.logs);
    assert.doesNotMatch(logged, /client@example|777777|29\.99|secret/i);
  });
});

test("missing or revoked credential fails before reading/enqueueing", async () => {
  await withRoute({ authenticate: async () => { throw new WooUnauthenticatedError(); } }, async (origin, calls) => {
    const response = await send(origin);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(calls.publish, 0);
  });
});

test("invalid body, header, query, spoofing and event family never enqueue", async () => {
  await withRoute({}, async (origin, calls) => {
    for (const [payload, expected] of [
      [{ ...event, shopId: "spoof" }, 400],
      [{ ...event, checkout: { ...event.checkout, contact: { consent: true } } }, 400],
      [{ ...orderPaid, order: { ...orderPaid.order, checkoutKey: "foreign-cart" } }, 400],
    ] as const) {
      const response = await send(origin, payload);
      assert.equal(response.status, expected);
    }
    assert.equal((await send(origin, event, "/v1/woocommerce/activity?shopId=spoof")).status, 400);
    assert.equal((await fetch(`${origin}/v1/woocommerce/activity`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(event),
    })).status, 400);
    assert.equal((await fetch(`${origin}/v1/woocommerce/activity`, {
      method: "POST", headers, body: JSON.stringify({ ...event, filler: "x".repeat(67_000) }),
    })).status, 413);
    assert.equal(calls.publish, 0);
    assert.equal(calls.orderPublish, 0);
    assert.equal((await fetch(`${origin}/v1/woocommerce/activity`, { method: "GET" })).status, 404);
  });
});

test("retained conflict is bounded 409; enqueue failure is retryable 503", async () => {
  for (const [failure, status, code] of [
    [new WooCheckoutReplayConflict(), 409, "event_replay_conflict"],
    [new Error("redis://secret:password@host"), 503, "queue_unavailable"],
  ] as const) {
    await withRoute({ publish: async () => { throw failure; } }, async (origin, calls) => {
      const response = await send(origin);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
      assert.doesNotMatch(JSON.stringify(calls.logs), /secret|password|29\.99/);
    });
  }
});

test("orders use authenticated shop and separate publisher, including order-first", async () => {
  await withRoute({ orderPublish: async (shopId, order) => {
    assert.equal(shopId, "server-shop");
    assert.equal(order.order.checkoutKey, order.checkoutKey);
    return { duplicate: false, jobId: "order-job" };
  } }, async (origin, calls) => {
    for (const order of [orderPlaced, orderPaid, orderCancelled]) {
      const response = await send(origin, order);
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { status: "accepted" });
    }
    assert.equal(calls.orderPublish, 3);
    assert.equal(calls.publish, 0);
    assert.match(JSON.stringify(calls.logs), /woocommerce.activity.order.accepted/);
    assert.doesNotMatch(JSON.stringify(calls.logs), /cart-001|woo-order-42|processing|completed/);
  });
});

test("order conflicts and queue failure have the same safe HTTP semantics", async () => {
  for (const [failure, expected, code] of [
    [new WooCheckoutReplayConflict(), 409, "event_replay_conflict"],
    [new Error("redis://secret:password@host"), 503, "queue_unavailable"],
  ] as const) {
    await withRoute({ orderPublish: async () => { throw failure; } }, async (origin, calls) => {
      const response = await send(origin, orderPlaced);
      assert.equal(response.status, expected);
      assert.deepEqual(await response.json(), { error: code });
      assert.equal(calls.publish, 0);
      assert.equal(calls.orderPublish, 1);
      assert.doesNotMatch(JSON.stringify(calls.logs), /secret|password|cart-001/);
    });
  }
});

test("a route without an order producer fails closed with 503", async () => {
  await withRoute({ disableOrderPublisher: true }, async (origin, calls) => {
    const response = await send(origin, orderPlaced);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "queue_unavailable" });
    assert.equal(calls.publish, 0);
    assert.equal(calls.orderPublish, 0);
  });
});
