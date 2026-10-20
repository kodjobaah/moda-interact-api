import assert from "node:assert/strict";
import test from "node:test";
import { Queue } from "bullmq";
import { WooInstallationAuthenticator } from "../../../../src/auth/woo-installation/authenticator.js";
import { digestSecret } from "../../../../src/auth/woo-installation/credential.js";
import { WOO_CHECKOUT_QUEUE, WOO_ORDER_QUEUE, type WooCheckoutJob, type WooOrderJob } from "../../../../src/woocommerce/activity/contract.js";
import { wooCheckoutJobId } from "../../../../src/woocommerce/activity/producer.js";
import { wooOrderJobId } from "../../../../src/woocommerce/activity/order-producer.js";
import { createWooCheckoutRedisProducer } from "../../../../src/woocommerce/activity/redis-producer.js";
import { createWooCheckoutActivityRoute } from "../../../../src/woocommerce/activity/routes.js";
import { createApiRuntime } from "../../../../src/server.js";
import { event } from "../../../fixtures/woocommerce/activity/checkout-event.js";
import { orderPlaced, orderPaid, orderCancelled } from "../../../fixtures/woocommerce/activity/order-event.js";

const url = process.env.WOO_ACTIVITY_TEST_REDIS_URL;
if (!url) throw new Error("WOO_ACTIVITY_TEST_REDIS_URL is required for integration tests");
const token = Buffer.alloc(32, 7);
const headers = (installation: string) => ({
  "x-moda-installation-id": installation,
  authorization: `Bearer ${token.toString("base64url")}`,
  "content-type": "application/json",
});
const auth = new WooInstallationAuthenticator({
  wooCommerceInstallation: { async findUnique({ where }: { where: { id: string } }) {
    if (!["install-a", "install-b", "revoked", "shopify"].includes(where.id)) return null;
    return {
      id: where.id, shopId: where.id === "install-b" ? "shop-b" : "shop-a",
      canonicalSiteUrl: "https://example.invalid", credentialVersion: 1,
      credentialDigest: digestSecret(token), status: where.id === "revoked" ? "REVOKED" : "ACTIVE", revokedAt: null,
      shop: { status: "ACTIVE", platform: where.id === "shopify" ? "SHOPIFY" : "WOOCOMMERCE", shopifyShopId: null },
    };
  } },
} as never);
const logger = { info() {}, warn() {}, error() {} } as never;
const connect = (port: number, installation: string, body: unknown = event, signal?: AbortSignal) => fetch(
  `http://127.0.0.1:${port}/v1/woocommerce/activity`,
  { method: "POST", headers: headers(installation), body: JSON.stringify(body), signal: signal ?? null },
);

test("actual authenticated HTTP -> Woo BullMQ queue with retained dedupe and tenant isolation", async () => {
  const redis = createWooCheckoutRedisProducer(url);
  const runtime = createApiRuntime({
    databaseUrl: "postgresql://unused:unused@localhost/db", host: "0.0.0.0", port: 0,
    environment: "test", readinessTimeoutMs: 100, woocommerceConnectionMode: "public", wooBilling: null,
  }, { async probe() {}, async disconnect() {} }, logger,
  [createWooCheckoutActivityRoute({ authenticator: auth, publisher: redis.publisher, orderPublisher: redis.orderPublisher, logger })], () => redis.close());
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const parsed = new URL(url);
  const connection = { host: parsed.hostname, port: Number(parsed.port || "6379") };
  const inspect = new Queue<WooCheckoutJob>(WOO_CHECKOUT_QUEUE, { connection });
  const orders = new Queue<WooOrderJob>(WOO_ORDER_QUEUE, { connection });
  try {
    // No checkout snapshot exists yet: order-first evidence is accepted independently.
    assert.equal((await connect(port, "install-a", orderPlaced)).status, 202);
    const firstOrder = await orders.getJob(wooOrderJobId("shop-a", orderPlaced.eventId));
    assert.equal(firstOrder?.name, "order-lifecycle");
    assert.equal(firstOrder?.data.shopId, "shop-a");
    assert.equal(firstOrder?.data.order.checkoutKey, "cart-001");
    assert.equal((await inspect.getWaiting()).length, 0);
    assert.equal((await connect(port, "install-a", orderPlaced)).status, 202);
    assert.equal((await orders.getWaiting()).length, 1);
    assert.equal((await connect(port, "install-a", { ...orderPlaced,
      order: { ...orderPlaced.order, status: "completed" },
    })).status, 409);
    for (const order of [orderPaid, orderCancelled]) {
      assert.equal((await connect(port, "install-a", order)).status, 202);
      assert.ok(await orders.getJob(wooOrderJobId("shop-a", order.eventId)));
    }
    assert.equal((await orders.getWaiting()).length, 3);
    assert.equal((await connect(port, "install-b", orderPlaced)).status, 202);
    assert.ok(await orders.getJob(wooOrderJobId("shop-b", orderPlaced.eventId)));
    assert.equal((await orders.getWaiting()).length, 4);
    assert.equal((await connect(port, "install-a", { ...orderPlaced, order: {
      ...orderPlaced.order, checkoutKey: "other-cart",
    } })).status, 400);
    assert.equal((await connect(port, "shopify", orderPlaced)).status, 401);
    assert.equal((await connect(port, "revoked")).status, 401);
    assert.equal((await connect(port, "shopify")).status, 401);
    assert.equal((await connect(port, "install-a", { ...event, shopId: "shop-b" })).status, 400);
    const accepted = await connect(port, "install-a");
    assert.equal(accepted.status, 202);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    assert.deepEqual(await accepted.json(), { status: "accepted" });
    const idA = wooCheckoutJobId("shop-a", event.eventId);
    const first = await inspect.getJob(idA);
    assert.equal(first?.data.schemaVersion, "woo.activity.v1");
    assert.equal(first?.data.shopId, "shop-a");
    assert.equal(first?.data.checkoutKey, "cart-001");
    assert.equal(first?.name, "checkout-updated");
    assert.equal((await connect(port, "install-a")).status, 202);
    assert.equal((await connect(port, "install-a", { ...event, checkout: { ...event.checkout, total: "1.01" } })).status, 409);
    assert.equal((await connect(port, "install-b")).status, 202);
    assert.ok(await inspect.getJob(wooCheckoutJobId("shop-b", event.eventId)));
    assert.equal((await inspect.getWaiting()).length, 2);
  } finally {
    await orders.close();
    await inspect.close();
    await runtime.shutdown();
  }
});

test("Redis transport failure never returns HTTP 202", async () => {
  // Port 1 is deliberately closed in disposable test environments.
  const redis = createWooCheckoutRedisProducer("redis://127.0.0.1:1");
  const runtime = createApiRuntime({
    databaseUrl: "postgresql://unused:unused@localhost/db", host: "0.0.0.0", port: 0,
    environment: "test", readinessTimeoutMs: 100, woocommerceConnectionMode: "public", wooBilling: null,
  }, { async probe() {}, async disconnect() {} }, logger,
  [createWooCheckoutActivityRoute({ authenticator: auth, publisher: redis.publisher, orderPublisher: redis.orderPublisher, logger })], () => redis.close());
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    // A disconnected Redis connection must not keep the HTTP request pending.
    const result = await connect(address.port, "install-a", event, AbortSignal.timeout(5_000));
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: "queue_unavailable" });
    const order = await connect(address.port, "install-a", orderPlaced, AbortSignal.timeout(5_000));
    assert.equal(order.status, 503);
    assert.deepEqual(await order.json(), { error: "queue_unavailable" });
  } finally { await runtime.shutdown(); }
});
