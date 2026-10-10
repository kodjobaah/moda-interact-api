import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { sealWooReadCredentials } from "./envelope.js";
import { WooReadVerificationError } from "./credential-verifier.js";
import { WooProductReadService } from "./provider-connection.service.js";

const logs: Array<Record<string, unknown>> = [];
const logger = {
  info: (_event: string, data: Record<string, unknown>) => { logs.push(data); },
  warn: (_event: string, data: Record<string, unknown>) => { logs.push(data); },
};
const config = {
  activeKeyId: "test-key", keys: new Map([["test-key", randomBytes(32)]]), publicOrigin: "https://api.invalid",
};
const fixtureProduct = { id: 22, name: "T-Shirt", sku: "TEE", price: "20", stock_status: "instock", stock_quantity: 5 };

function createInstallation(shopId: string, secret: string) {
  const id = `installation-${shopId}`;
  const attemptId = `attempt-${shopId}`;
  const envelope = sealWooReadCredentials({ consumerKey: `ck_${shopId}`, consumerSecret: secret }, {
    shopId, installationId: id, authorizationAttemptId: attemptId, credentialVersionSnapshot: 1,
  }, config);
  return {
    id, shopId, canonicalSiteUrl: `https://${shopId}.example.com`, status: "ACTIVE", revokedAt: null,
    credentialVersion: 1,
    shop: { status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null, domain: `https://${shopId}.example.com` },
    restReadGrant: {
      id: `grant-${shopId}`, installationId: id, shopId, authorizationAttemptId: attemptId,
      status: "ACTIVE", authorizedScope: "read", credentialVersionSnapshot: 1, rotationVersion: 1,
      ...envelope,
    },
  };
}

function fixture() {
  const shops = {
    a: { installation: createInstallation("a", "secret-a") },
    b: { installation: createInstallation("b", "secret-b") },
  };
  const mutations: Array<{ where: unknown; data: unknown }> = [];
  const database = {
    wooCommerceInstallation: {
      findUnique: async ({ where }: { where: { shopId: string } }) => shops[where.shopId as keyof typeof shops]?.installation ?? null,
    },
    wooCommerceRestReadGrant: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        mutations.push(args);
        const grant = shops[args.where.shopId as keyof typeof shops]?.installation.restReadGrant;
        if (!grant || grant.id !== args.where.id || grant.rotationVersion !== args.where.rotationVersion ||
          grant.status !== args.where.status) return { count: 0 };
        grant.status = String(args.data.status);
        return { count: 1 };
      },
    },
  };
  const outbound: Array<{ site: string; key: string; secret: string; method: string }> = [];
  let readFailure: WooReadVerificationError | undefined;
  let verificationFailure: WooReadVerificationError | undefined;
  let onFetch: (() => void) | undefined;
  const transport = {
    fetchProductOperation: async (site: { canonicalSiteUrl: string }, credentials: { consumerKey: string; consumerSecret: string }, request: { operation: string }) => {
      outbound.push({ site: site.canonicalSiteUrl, key: credentials.consumerKey, secret: credentials.consumerSecret, method: request.operation });
      onFetch?.();
      if (readFailure) throw readFailure;
      return request.operation === "products.list" ? [fixtureProduct] : fixtureProduct;
    },
    verify: async () => { if (verificationFailure) throw verificationFailure; },
  };
  const service = new WooProductReadService(database as never, config, "public", transport, logger);
  return { shops, database, mutations, outbound, service,
    setReadFailure: (value: WooReadVerificationError) => { readFailure = value; },
    setVerificationFailure: (value: WooReadVerificationError) => { verificationFailure = value; },
    onFetch: (callback: () => void) => { onFetch = callback; },
  };
}

test("tenant isolation: each shop's grant is used only for that shop", async () => {
  const context = fixture();
  assert.equal((await context.service.read("a", { operation: "products.list" })).ok, true);
  assert.equal((await context.service.read("b", { operation: "products.retrieve", productId: 22 })).ok, true);
  assert.deepEqual(context.outbound.map(({ site, key }) => [site, key]), [
    ["https://a.example.com", "ck_a"], ["https://b.example.com", "ck_b"],
  ]);
  assert.equal(logs.some((entry) => JSON.stringify(entry).includes("secret-a")), false);
  assert.equal(logs.some((entry) => JSON.stringify(entry).includes("ck_a")), false);
  assert.equal(context.mutations.length, 0);
});

test("missing, revoked, stale and mismatched grants fail closed", async () => {
  const context = fixture();
  context.shops.a.installation.restReadGrant.status = "REVOKED";
  assert.deepEqual(await context.service.read("a", { operation: "products.list" }), {
    ok: false, operation: "products.list", reason: "reauthorization_required",
  });
  context.shops.a.installation.restReadGrant.status = "ACTIVE";
  context.shops.a.installation.credentialVersion = 2;
  assert.equal((await context.service.read("a", { operation: "products.list" })).ok, false);
  context.shops.a.installation.credentialVersion = 1;
  context.shops.a.installation.shop.platform = "SHOPIFY";
  assert.equal((await context.service.read("a", { operation: "products.list" })).ok, false);
  context.shops.a.installation.shop.platform = "WOOCOMMERCE";
  context.shops.a.installation.shop.domain = "https://another.example.com";
  assert.equal((await context.service.read("a", { operation: "products.list" })).ok, false);
  assert.equal(context.outbound.length, 0);
});

test("unsupported requests, unknown shop and missing decryption key never invoke provider", async () => {
  const context = fixture();
  assert.equal((await context.service.read("a", { operation: "orders.list" } as never)).ok, false);
  assert.equal((await context.service.read("missing", { operation: "products.list" })).ok, false);
  context.shops.a.installation.restReadGrant.encryptionKeyId = "missing-key";
  assert.deepEqual(await context.service.read("a", { operation: "products.list" }), {
    ok: false, operation: "products.list", reason: "provider_unavailable",
  });
  assert.equal(context.outbound.length, 0);
});

test("grant revoked during network read returns no data", async () => {
  const context = fixture();
  context.onFetch(() => { context.shops.a.installation.restReadGrant.status = "REVOKED"; });
  assert.deepEqual(await context.service.read("a", { operation: "products.list" }), {
    ok: false, operation: "products.list", reason: "reauthorization_required",
  });
});

test("product 403 followed by successful grant check does not invalidate grant", async () => {
  const context = fixture();
  context.setReadFailure(new WooReadVerificationError("rejected_credentials"));
  assert.deepEqual(await context.service.read("a", { operation: "products.retrieve", productId: 42 }), {
    ok: false, operation: "products.retrieve", reason: "provider_forbidden",
  });
  assert.equal(context.mutations.length, 0);
});

test("confirmed provider credential failure marks only the current grant invalid", async () => {
  const context = fixture();
  context.setReadFailure(new WooReadVerificationError("rejected_credentials"));
  context.setVerificationFailure(new WooReadVerificationError("rejected_credentials"));
  assert.deepEqual(await context.service.read("a", { operation: "products.list" }), {
    ok: false, operation: "products.list", reason: "reauthorization_required",
  });
  assert.equal(context.mutations.length, 1);
  assert.deepEqual(Object.keys(context.mutations[0]!.data as object), ["status", "invalidatedAt"]);
  assert.equal(context.shops.a.installation.restReadGrant.status, "INVALID");
  assert.equal(context.shops.b.installation.restReadGrant.status, "ACTIVE");
});

test("provider timeout, malformed response and missing product remain bounded", async () => {
  const context = fixture();
  context.setReadFailure(new WooReadVerificationError("unreachable"));
  assert.deepEqual(await context.service.read("a", { operation: "products.list" }), {
    ok: false, operation: "products.list", reason: "provider_unavailable",
  });
  context.setReadFailure(new WooReadVerificationError("not_found"));
  assert.deepEqual(await context.service.read("a", { operation: "products.retrieve", productId: 500 }), {
    ok: false, operation: "products.retrieve", reason: "not_found",
  });
  assert.equal(context.mutations.length, 0);
});
