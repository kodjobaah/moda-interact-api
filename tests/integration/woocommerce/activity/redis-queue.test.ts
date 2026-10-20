import assert from "node:assert/strict";
import test from "node:test";
import { Queue } from "bullmq";
import { WooInstallationAuthenticator } from "../../../../src/auth/woo-installation/authenticator.js";
import { digestSecret } from "../../../../src/auth/woo-installation/credential.js";
import { WOO_CHECKOUT_QUEUE, type WooCheckoutJob } from "../../../../src/woocommerce/activity/contract.js";
import { wooCheckoutJobId } from "../../../../src/woocommerce/activity/producer.js";
import { createWooCheckoutRedisProducer } from "../../../../src/woocommerce/activity/redis-producer.js";
import { createWooCheckoutActivityRoute } from "../../../../src/woocommerce/activity/routes.js";
import { createApiRuntime } from "../../../../src/server.js";
import { event } from "../../../fixtures/woocommerce/activity/checkout-event.js";

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
const connect = (port: number, installation: string, body: unknown = event) => fetch(
  `http://127.0.0.1:${port}/v1/woocommerce/activity`,
  { method: "POST", headers: headers(installation), body: JSON.stringify(body) },
);

test("actual authenticated HTTP -> Woo BullMQ queue with retained dedupe and tenant isolation", async () => {
  const redis = createWooCheckoutRedisProducer(url);
  const runtime = createApiRuntime({
    databaseUrl: "postgresql://unused:unused@localhost/db", host: "0.0.0.0", port: 0,
    environment: "test", readinessTimeoutMs: 100, woocommerceConnectionMode: "public", wooBilling: null,
  }, { async probe() {}, async disconnect() {} }, logger,
  [createWooCheckoutActivityRoute({ authenticator: auth, publisher: redis.publisher, logger })], () => redis.close());
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const parsed = new URL(url);
  const inspect = new Queue<WooCheckoutJob>(WOO_CHECKOUT_QUEUE, {
    connection: { host: parsed.hostname, port: Number(parsed.port || "6379") },
  });
  try {
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
    assert.equal((await connect(port, "install-a", { ...event, eventType: "ORDER_PLACED", order: { orderId: "1", status: "processing" } })).status, 422);
  } finally {
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
  [createWooCheckoutActivityRoute({ authenticator: auth, publisher: redis.publisher, logger })], () => redis.close());
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await connect(address.port, "install-a");
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: "queue_unavailable" });
  } finally { await runtime.shutdown(); }
});
