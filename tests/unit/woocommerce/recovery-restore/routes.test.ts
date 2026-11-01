import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { WOO_RESTORE_RESOLVE_PATH } from "../../../../src/woocommerce/recovery-restore/contract.js";
import { createWooRecoveryRestoreRoute } from "../../../../src/woocommerce/recovery-restore/routes.js";

const token = Buffer.alloc(32, 7).toString("base64url");
const payload = { schemaVersion: "woo.restore.resolve.v1", recoveryId: "recovery_123", token };
const eligible = {
  schemaVersion: "woo.restore.resolve.v1",
  status: "eligible",
  recoveryId: payload.recoveryId,
  checkoutKey: "checkout_key_123",
  snapshot: {
    schemaVersion: "woo.cart-restore.v1", kind: "supported", appliedCouponCodes: ["OLD10"],
    lines: [{ productId: "101", quantity: 2 }],
  },
  outreachOffer: { kind: "NONE", reason: "NO_CONFIRMED_OFFER" },
};
const principal = {
  installationId: "install_123", shopId: "shop_123", canonicalSiteUrl: "https://merchant.example", credentialVersion: 1,
};

async function exercise(options: Parameters<typeof createWooRecoveryRestoreRoute>[0],
  body: string, suffix = "", headers: Record<string, string> = { "content-type": "application/json" }) {
  const route = createWooRecoveryRestoreRoute(options);
  const server = createServer((request, response) => {
    void route.handle(request, response).then(handled => {
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}${WOO_RESTORE_RESOLVE_PATH}${suffix}`, {
      method: "POST", headers, body,
    });
    return { status: response.status, cache: response.headers.get("cache-control"), json: await response.json() };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("installation-authenticated resolve returns the strict no-store v1 contract", async () => {
  const calls: unknown[] = [];
  const result = await exercise({
    authenticator: { async authenticate() { calls.push("auth"); return principal; } },
    service: { async resolve(actualPrincipal, request) { calls.push([actualPrincipal, request]); return eligible as never; } },
    logger: { info() {}, warn() {}, error() {} } as never,
  }, JSON.stringify(payload));

  assert.equal(result.status, 200);
  assert.equal(result.cache, "no-store");
  assert.deepEqual(result.json, eligible);
  assert.equal((calls[0] as string), "auth");
  assert.deepEqual(calls[1], [principal, payload]);
});

test("the same v1 route forwards a complete ordered offer union without caching", async () => {
  const grouped = {
    ...eligible,
    outreachOffer: {
      kind: "CHECKOUT_OFFERS",
      offers: [
        { method: "CODE", code: "SAVE15", providerDiscountId: "discount-one" },
        { method: "AUTOMATIC", providerDiscountId: "discount-two" },
      ],
    },
  };
  const result = await exercise({
    authenticator: { async authenticate() { return principal; } },
    service: { async resolve() { return grouped as never; } },
    logger: { info() {}, warn() {}, error() {} } as never,
  }, JSON.stringify(payload));

  assert.equal(result.status, 200);
  assert.equal(result.cache, "no-store");
  assert.deepEqual(result.json, grouped);
});

test("strict request schema rejects unknown fields, wrong version, invalid token and query parameters", async () => {
  let resolutions = 0;
  const options = {
    authenticator: { async authenticate() { return principal; } },
    service: { async resolve() { resolutions += 1; return eligible as never; } },
    logger: { info() {}, warn() {}, error() {} } as never,
  };
  for (const body of [
    JSON.stringify({ ...payload, shopId: "shop_attacker" }),
    JSON.stringify({ ...payload, schemaVersion: "woo.restore.resolve.v2" }),
    JSON.stringify({ ...payload, token: "too-short" }),
    "not-json",
  ]) {
    const result = await exercise(options, body);
    assert.equal(result.status, 400);
    assert.deepEqual(result.json, { error: "invalid_request" });
  }
  const withQuery = await exercise(options, JSON.stringify(payload), "?shopId=shop_attacker");
  assert.equal(withQuery.status, 400);
  assert.deepEqual(withQuery.json, { error: "invalid_request" });
  const oversized = await exercise(options, " ".repeat(4097));
  assert.equal(oversized.status, 400);
  assert.equal(resolutions, 0);
});

test("unauthenticated requests are rejected before resolver access; recovery denial is uniform 404", async () => {
  let resolutions = 0;
  const options = {
    authenticator: { async authenticate() { throw new WooUnauthenticatedError(); } },
    service: { async resolve() { resolutions += 1; return null; } },
    logger: { info() {}, warn() {}, error() {} } as never,
  };
  const unauthorized = await exercise(options, JSON.stringify(payload));
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(unauthorized.json, { error: "unauthorized" });
  assert.equal(resolutions, 0);

  const denied = await exercise({ ...options,
    authenticator: { async authenticate() { return principal; } },
  }, JSON.stringify(payload));
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.json, { error: "restore_unavailable" });
});

test("unexpected dependency errors return bounded 503 and logs retain only redacted error details", async () => {
  const logLines: string[] = [];
  const secretError = new Error(`database request failed ${token} https://merchant.example/?t=${token} customer@example.com +1 (415) 555-0132 OLD10`);
  const result = await exercise({
    authenticator: { async authenticate() { return principal; } },
    service: { async resolve() { throw secretError; } },
    logger: {
      info(event: string, fields: unknown) { logLines.push(JSON.stringify([event, fields])); },
      warn(event: string, fields: unknown) { logLines.push(JSON.stringify([event, fields])); },
      error(event: string, fields: unknown) { logLines.push(JSON.stringify([event, fields])); },
    } as never,
  }, JSON.stringify(payload));
  assert.equal(result.status, 503);
  assert.deepEqual(result.json, { error: "restore_unavailable" });
  assert.equal(logLines.join("\n").includes("database request failed"), true);
  assert.equal(logLines.join("\n").includes(token), false);
  assert.equal(logLines.join("\n").includes("merchant.example"), false);
  assert.equal(logLines.join("\n").includes("customer@example.com"), false);
  assert.equal(logLines.join("\n").includes("415"), false);
  assert.equal(logLines.join("\n").includes("OLD10"), false);
});