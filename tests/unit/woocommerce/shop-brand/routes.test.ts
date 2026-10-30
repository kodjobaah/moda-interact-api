import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { createWooShopBrandRoute } from "../../../../src/woocommerce/shop-brand/routes.js";
import { WOO_SHOP_BRAND_PATH } from "../../../../src/woocommerce/shop-brand/contract.js";
import { composeApiRoutes } from "../../../../src/composition/routes.js";

const snapshot = {
  schemaVersion: "woo.shop-brand.v1", eventId: "event-001", observedAt: "2026-10-27T10:00:00Z",
  brandName: "Merchant", logo: null, siteIcon: null, coverImage: null,
};
const principal = { installationId: "inst-1", shopId: "shop-1", canonicalSiteUrl: "https://woo.example",
  credentialVersion: 1 };
const events: Array<{ level: string; metadata: Record<string, unknown> | undefined }> = [];
const logger = {
  info(_name: string, metadata?: Record<string, unknown>) { events.push({ level: "info", metadata }); },
  warn(_name: string, metadata?: Record<string, unknown>) { events.push({ level: "warn", metadata }); },
  error() {},
} as never;
type Deps = Parameters<typeof createWooShopBrandRoute>[0];
async function post(deps: Deps, body: string, suffix = "", headers: Record<string, string> = {}) {
  const route = createWooShopBrandRoute(deps);
  const server = createServer((request, response) => {
    void route.handle(request, response).then(handled => {
      if (!handled && !response.headersSent) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${WOO_SHOP_BRAND_PATH}${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body,
    });
    return { status: response.status, body: await response.json() as Record<string, string>,
      cache: response.headers.get("cache-control"), mime: response.headers.get("content-type") };
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("authenticates before body read and rejects spoofed shopId", async () => {
  let writes = 0;
  const deps: Deps = { authenticator: { authenticate: async () => principal }, logger,
    service: { record: async (p, value) => {
      assert.equal(p.shopId, "shop-1"); assert.equal(value.eventId, "event-001");
      writes++; return { status: "updated" };
    } } };
  const success = await post(deps, JSON.stringify(snapshot));
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, { status: "updated" });
  assert.equal(success.cache, "no-store");
  assert.match(success.mime!, /^application\/json/);
  assert.equal(writes, 1);
  assert.deepEqual((await post(deps, JSON.stringify({ ...snapshot, shopId: "victim" }))).body,
    { error: "invalid_request" });
  assert.equal((await post(deps, JSON.stringify(snapshot), "?shopId=victim")).status, 400);
  assert.equal(writes, 1);
  const denied = await post({ ...deps, authenticator: { authenticate: async () => {
    throw new WooUnauthenticatedError();
  } } }, "{invalid json");
  assert.deepEqual([denied.status, denied.body], [401, { error: "unauthorized" }]);
  assert.equal(writes, 1);
});

test("awaits durable commit, responds 503 without leaking raw DB exceptions", async () => {
  let commit!: () => void;
  const barrier = new Promise<void>(resolve => { commit = resolve; });
  const deps: Deps = { authenticator: { authenticate: async () => principal }, logger,
    service: { record: async () => { await barrier; return { status: "unchanged" }; } } };
  // Assert via a standalone raw server that response is not ended before commit.
  const route = createWooShopBrandRoute(deps);
  const server = createServer((req, res) => { void route.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    let settled = false;
    const port = (server.address() as AddressInfo).port;
    const pending = fetch(`http://127.0.0.1:${port}${WOO_SHOP_BRAND_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot),
    }).then(() => { settled = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    assert.equal(settled, false);
    commit();
    await pending;
    const failure = await post({ ...deps, service: { record: async () => {
      throw new Error("PG URL=https://private.example/secret bearer-credential");
    } } }, JSON.stringify(snapshot));
    assert.deepEqual([failure.status, failure.body], [503, { error: "shop_brand_unavailable" }]);
    const unavailable = events.find((item) => item.level === "warn" && item.metadata?.reason === "database_unavailable");
    assert.equal(unavailable?.metadata?.errorName, "Error");
    assert.equal(unavailable?.metadata?.errorMessage,
      "PG URL=https://private.example/secret bearer-credential");
    assert.match(String(unavailable?.metadata?.errorStack), /private\.example/);
  } finally { commit(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("validation rejections retain the response contract and log their original message", async () => {
  events.length = 0;
  const result = await post({
    authenticator: { authenticate: async () => principal }, logger,
    service: { record: async () => ({ status: "updated" }) },
  }, JSON.stringify({ ...snapshot, observedAt: "2026-10-28T12:00:01.123456Z" }));
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: "invalid_request" });
  const failure = events.find((event) => event.level === "warn" && event.metadata?.reason === "invalid_request");
  assert.equal(failure?.metadata?.errorMessage, "invalid_request");
  assert.equal(failure?.metadata?.errorName, "Error");
});

test("route participates in the Woo composition before merchant fallbacks", async () => {
  const shopBrand = createWooShopBrandRoute({ authenticator: { authenticate: async () => principal }, logger,
    service: { record: async () => ({ status: "updated" }) } });
  const noOp = { handle: async () => false };
  const routes = composeApiRoutes({ wooBillingWebhook: noOp, wooShopBrand: shopBrand,
    merchant: [], billing: [], wooInstallation: noOp });
  assert.ok(routes.includes(shopBrand));
  assert.equal(routes[1], shopBrand);
});
