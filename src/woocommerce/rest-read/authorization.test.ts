import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { loadWooRestReadAuthorizationConfig } from "./config.js";
import { openWooReadCredentials, sealWooReadCredentials } from "./envelope.js";
import { WooReadCredentialVerifier, WooReadVerificationError } from "./credential-verifier.js";
import { WooReadAuthorizationService, WooReadAuthorizationError } from "./authorization.service.js";
import { digestSecret } from "../installation/credential.js";
import type { WooInstallationPrincipal } from "../installation/authenticator.js";
import { canonicalizeWooSiteUrl } from "../installation/site-url.js";

function config() {
  const value = loadWooRestReadAuthorizationConfig({
    MODA_WOO_REST_READ_PUBLIC_ORIGIN: "https://api.example.org",
    MODA_WOO_REST_READ_ACTIVE_KEY_ID: "v1",
    MODA_WOO_REST_READ_KEYRING: JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64url") }),
  }, "public");
  assert.ok(value);
  return value;
}

const principal: WooInstallationPrincipal = {
  installationId: "installation-1", shopId: "shop-1", credentialVersion: 1,
  canonicalSiteUrl: "https://store.example.org/woocommerce",
};

test("authorization configuration is disabled by default and rejects unsafe/partial setups", () => {
  assert.equal(loadWooRestReadAuthorizationConfig({}, "public"), null);
  assert.throws(() => loadWooRestReadAuthorizationConfig({ MODA_WOO_REST_READ_PUBLIC_ORIGIN: "https://api.example.org" }, "public"));
  const env = { MODA_WOO_REST_READ_PUBLIC_ORIGIN: "https://api.example.org",
    MODA_WOO_REST_READ_ACTIVE_KEY_ID: "v1",
    MODA_WOO_REST_READ_KEYRING: JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64url") }) };
  for (const origin of ["http://public.example.org", "https://localhost", "https://127.0.0.1", "https://api.example.org:8443", "https://evil.example.org/path", "https://user:pass@api.example.org", "https://api.example.org?a=1"]) {
    assert.throws(() => loadWooRestReadAuthorizationConfig({ ...env, MODA_WOO_REST_READ_PUBLIC_ORIGIN: origin }, "public"));
  }
  assert.throws(() => loadWooRestReadAuthorizationConfig({ ...env, MODA_WOO_REST_READ_KEYRING: JSON.stringify({ v1: "too-short" }) }, "public"));
});

test("AES-GCM protects both keys, uses AAD bound to exact shop, installation and attempt", () => {
  const ctx = { shopId: "shop-1", installationId: "installation-1", authorizationAttemptId: "attempt-1", credentialVersionSnapshot: 1 };
  const keys = { consumerKey: `ck_${"a".repeat(40)}`, consumerSecret: `cs_${"b".repeat(40)}` };
  const sealed = sealWooReadCredentials(keys, ctx, config());
  assert.equal(sealed.credentialNonce.length, 12);
  assert.equal(sealed.credentialAuthTag.length, 16);
  assert.equal(sealed.credentialCiphertext.includes(Buffer.from(keys.consumerSecret)), false);
  assert.deepEqual(openWooReadCredentials(sealed, ctx, config()), keys);
  assert.throws(() => openWooReadCredentials(sealed, { ...ctx, shopId: "another-shop" }, config()), /envelope_invalid/);
  assert.throws(() => openWooReadCredentials(sealed, { ...ctx, authorizationAttemptId: "another-attempt" }, config()), /envelope_invalid/);
  assert.throws(() => openWooReadCredentials({ ...sealed, credentialAuthTag: Buffer.alloc(16) }, ctx, config()), /envelope_invalid/);
  assert.throws(() => openWooReadCredentials({ ...sealed, encryptionKeyId: "missing" }, ctx, config()), /envelope_invalid/);
});

test("one start issues one bounded read consent URL and never stores the bearer token", async () => {
  let stored: Record<string, unknown> | undefined;
  const token = Buffer.alloc(32, 22);
  const database = {
    wooCommerceRestReadAttempt: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        stored = data;
        return { id: "cuid_attempt_1", expiresAt: data.expiresAt };
      },
    },
  };
  const now = new Date("2026-10-10T12:00:00.000Z");
  const service = new WooReadAuthorizationService(database as never, config(), "public", {
    verify: async () => undefined,
  }, () => now, () => token);
  const start = await service.start(principal);
  const consent = new URL(start.authorizationUrl);
  assert.equal(consent.origin, "https://store.example.org");
  assert.equal(consent.pathname, "/woocommerce/wc-auth/v1/authorize");
  assert.equal(consent.searchParams.get("scope"), "read");
  assert.equal(consent.searchParams.get("app_name"), "Moda Interact");
  assert.equal(consent.searchParams.get("user_id"), "cuid_attempt_1");
  assert.equal(consent.searchParams.get("return_url"), "https://api.example.org/v1/woocommerce/read-authorizations/return");
  assert.equal(consent.searchParams.get("callback_url"),
    `https://api.example.org/v1/woocommerce/read-authorizations/callback/${token.toString("base64url")}`);
  assert.equal(start.expiresAt, "2026-10-10T12:10:00.000Z");
  assert.ok(stored);
  assert.deepEqual(Buffer.from(stored.tokenDigest as Uint8Array), digestSecret(token));
  assert.equal(JSON.stringify(stored).includes(token.toString("base64url")), false);
});

test("pinned read credential verification permits only local-dev loopback and rejects redirect/unexpected shapes", async () => {
  let responseStatus = 200;
  let responseBody = "[]";
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/shop/wp-json/wc/v3/products?per_page=1&_fields=id");
    assert.equal(request.headers.authorization,
      `Basic ${Buffer.from(`ck_${"a".repeat(40)}:cs_${"b".repeat(40)}`).toString("base64")}`);
    response.writeHead(responseStatus, { "content-type": "application/json" });
    response.end(responseBody);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  try {
    const site = canonicalizeWooSiteUrl(`http://localhost:${addr.port}/shop`, "local-development");
    const credentials = { consumerKey: `ck_${"a".repeat(40)}`, consumerSecret: `cs_${"b".repeat(40)}` };
    const verifier = new WooReadCredentialVerifier({ mode: "local-development", resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    await verifier.verify(site, credentials);
    responseStatus = 302;
    await assert.rejects(verifier.verify(site, credentials), (error) => error instanceof WooReadVerificationError && error.reason === "invalid_response");
    responseStatus = 200;
    responseBody = "{\"notProducts\":true}";
    await assert.rejects(verifier.verify(site, credentials), (error) => error instanceof WooReadVerificationError && error.reason === "invalid_response");
    const production = new WooReadCredentialVerifier({ mode: "public", resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    await assert.rejects(production.verify(site, credentials), (error) => error instanceof WooReadVerificationError && error.reason === "unsafe_target");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("callback rejects wrong-shop, expired and terminal attempts without calling the provider", async () => {
  const token = randomBytes(32);
  let checks = 0;
  const now = new Date("2026-10-10T12:00:00.000Z");
  const attempt = {
    id: "attempt-1", shopId: principal.shopId, installationId: principal.installationId,
    status: "PENDING", credentialVersionSnapshot: 1, expiresAt: new Date(now.getTime() + 60000),
    attemptSequence: 1n, installation: {
      shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl, status: "ACTIVE", revokedAt: null,
      credentialVersion: 1, shop: { status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null },
    },
  };
  const database = { wooCommerceRestReadAttempt: { findUnique: async () => attempt } };
  const service = new WooReadAuthorizationService(database as never, config(), "public", { verify: async () => { checks += 1; } }, () => now);
  const payload = { key_id: 5, user_id: "wrong-attempt", key_permissions: "read" as const,
    consumer_key: `ck_${"a".repeat(40)}`, consumer_secret: `cs_${"b".repeat(40)}` };
  await assert.rejects(service.callback(token.toString("base64url"), payload), (error) => error instanceof WooReadAuthorizationError && error.code === "invalid_attempt");
  attempt.installation.shopId = "wrong-shop";
  await assert.rejects(service.callback(token.toString("base64url"), { ...payload, user_id: attempt.id }),
    (error) => error instanceof WooReadAuthorizationError && error.code === "shop_unavailable");
  assert.equal(checks, 0);
  attempt.status = "FAILED";
  await assert.rejects(service.callback(token.toString("base64url"), { ...payload, user_id: attempt.id }),
    (error) => error instanceof WooReadAuthorizationError && error.code === "attempt_expired");
  assert.equal(checks, 0);
});
