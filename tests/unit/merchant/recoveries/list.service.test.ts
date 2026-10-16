import assert from "node:assert/strict";
import test from "node:test";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { MerchantRecoveryListService } from "../../../../src/merchant/recoveries/list.service.js";
import { RecoveryListIntegrityError } from "../../../../src/merchant/recoveries/contract.js";
import { isRecoveryListResponse } from "../../../../src/merchant/recoveries/schema.js";

const principal: WooInstallationPrincipal = {
  installationId: "woo-install", shopId: "woo-shop", canonicalSiteUrl: "https://woo.example",
  credentialVersion: 4,
};
const detectedAt = new Date("2026-10-10T16:00:00.000Z");
const baseShop = {
  id: "woo-shop", domain: "https://woo.example", platform: "WOOCOMMERCE", shopifyShopId: null,
  status: "ACTIVE", defaultTimeZone: "Europe/London",
};
const baseInstallation = {
  id: "woo-install", shopId: "woo-shop", canonicalSiteUrl: "https://woo.example",
  status: "ACTIVE", revokedAt: null, credentialVersion: 4,
};
const recovery = {
  id: "recovery_123", status: "COMPLETED", detectedAt,
  lastExternalActivityAt: new Date("2026-10-10T16:45:00.000Z"),
  totalPrice: { toString: () => "102.123456" }, currency: "GBP",
  checkoutUrl: "https://woo.example?token=must-not-escape",
  checkoutToken: "private-checkout-token",
  customer: { shopId: "woo-shop", firstName: "Ada", lastName: "Lovelace", email: "ada@example.invalid", phone: "+4412345678" },
};

function makeService(options: {
  shop?: unknown; installation?: unknown; total?: number; rows?: unknown[];
} = {}) {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const shop = options.shop === undefined ? baseShop : options.shop;
  const installation = options.installation === undefined ? baseInstallation : options.installation;
  const db = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>, input: unknown) => {
      calls.push({ operation: "transaction", input });
      return callback({
        shop: { findUnique: async (args: unknown) => { calls.push({ operation: "shop", input: args }); return shop; } },
        wooCommerceInstallation: {
          findUnique: async (args: unknown) => { calls.push({ operation: "installation", input: args }); return installation; },
        },
        checkoutRecovery: {
          count: async (args: unknown) => { calls.push({ operation: "count", input: args }); return options.total ?? 1; },
          findMany: async (args: unknown) => { calls.push({ operation: "page", input: args }); return options.rows ?? [recovery]; },
        },
      });
    },
  };
  return {
    service: new MerchantRecoveryListService(db as never, () => new Date("2026-10-11T19:30:00.000Z")),
    calls,
  };
}

function selection(calls: Array<{ operation: string; input: unknown }>, name: string): Record<string, unknown> {
  const entry = calls.find(({ operation }) => operation === name);
  assert.ok(entry, `Expected ${name} query`);
  return entry.input as Record<string, unknown>;
}

test("authenticates Woo shop within the snapshot; count and page are scoped and ordered", async () => {
  const { service, calls } = makeService({ total: 12 });
  const response = await service.read(principal, new URLSearchParams("page=2&pageSize=10"));
  assert.equal(response.page, 2);
  assert.equal(response.pageSize, 10);
  assert.equal(response.total, 12);
  assert.equal(response.totalPages, 2);
  assert.equal(response.hasPrevious, true);
  assert.equal(response.hasNext, false);
  assert.equal(response.timeZone, "Europe/London");
  assert.deepEqual(selection(calls, "transaction"), { isolationLevel: "RepeatableRead" });
  assert.deepEqual(selection(calls, "count").where, selection(calls, "page").where);
  const where = selection(calls, "count").where as Record<string, unknown>;
  assert.equal(where.shopId, principal.shopId);
  assert.deepEqual(where.detectedAt, {
    gte: new Date("2026-09-11T23:00:00.000Z"), lt: new Date("2026-10-11T23:00:00.000Z"),
  });
  assert.deepEqual(selection(calls, "page").orderBy, [{ detectedAt: "desc" }, { id: "desc" }]);
  assert.equal(selection(calls, "page").skip, 10);
  assert.equal(selection(calls, "page").take, 10);
  assert.deepEqual(response.items, [{
    id: "recovery_123", status: "COMPLETED", detectedAt: detectedAt.toISOString(),
    lastActivityAt: "2026-10-10T16:45:00.000Z", totalPrice: "102.123456", currency: "GBP",
    customer: { displayName: "Ada Lovelace", email: "ada@example.invalid" },
  }]);
  assert.equal(isRecoveryListResponse(response), true);
  assert.doesNotMatch(JSON.stringify(response), /private-checkout-token|must-not-escape|\+4412345678|woo-shop/);
  assert.equal(calls.filter(({ operation }) => ["count", "page"].includes(operation)).length, 2);
});

test("ongoing and full-name search retain tenant scopes for both count and page", async () => {
  const { service, calls } = makeService({ total: 0, rows: [] });
  const response = await service.read(principal, new URLSearchParams("status=ongoing&q=Ada%20Lovelace"));
  assert.equal(response.total, 0);
  assert.equal(response.totalPages, 1);
  assert.equal(response.page, 1);
  assert.equal(response.hasPrevious, false);
  assert.equal(response.hasNext, false);
  const where = selection(calls, "count").where as Record<string, unknown>;
  assert.deepEqual(where.status, { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] });
  const matching = where.AND as Array<{ customer: { is: { shopId: string; OR: unknown[] } } }>;
  assert.equal(matching.length, 2);
  assert.ok(matching.every(({ customer }) => customer.is.shopId === principal.shopId && customer.is.OR.length === 3));
  assert.deepEqual(selection(calls, "page").where, where);
});

test("first page advertises Next and does not request data beyond page size", async () => {
  const { service, calls } = makeService({ total: 51 });
  const result = await service.read(principal, new URLSearchParams("page=1&pageSize=25"));
  assert.deepEqual([result.page, result.totalPages, result.hasPrevious, result.hasNext], [1, 3, false, true]);
  assert.equal(selection(calls, "page").skip, 0);
  assert.equal(selection(calls, "page").take, 25);
});

test("clamps requested page to real last page and uses consistent skip/take", async () => {
  const { service, calls } = makeService({ total: 52, rows: [] });
  const response = await service.read(principal, new URLSearchParams("page=9999&pageSize=25&status=COMPLETED"));
  assert.deepEqual([response.page, response.totalPages, response.hasPrevious, response.hasNext], [3, 3, true, false]);
  assert.deepEqual(selection(calls, "count").where && (selection(calls, "count").where as Record<string, unknown>).status,
    "COMPLETED");
  assert.equal(selection(calls, "page").skip, 50);
  assert.equal(selection(calls, "page").take, 25);
});

test("empty shop response is an honest zero with default first page", async () => {
  const { service } = makeService({ total: 0, rows: [] });
  const response = await service.read(principal, new URLSearchParams());
  assert.deepEqual([response.items, response.total, response.page, response.totalPages], [[], 0, 1, 1]);
});

test("null customer, null amount and invalid currency are safely projected", async () => {
  const { service } = makeService({ rows: [{ ...recovery, customer: null, totalPrice: null, currency: "<private>" }] });
  const response = await service.read(principal, new URLSearchParams());
  assert.deepEqual(response.items[0]?.customer, null);
  assert.deepEqual([response.items[0]?.totalPrice, response.items[0]?.currency], [null, null]);
  assert.equal(isRecoveryListResponse(response), true);
});

test("Shop mismatch, Shopify platform, revoked installation and changed credential cannot read rows", async () => {
  for (const option of [
    { shop: null }, { shop: { ...baseShop, platform: "SHOPIFY" } },
    { shop: { ...baseShop, domain: "https://foreign.example" } },
    { shop: { ...baseShop, shopifyShopId: "gid://Shopify/Shop/123" } },
    { shop: { ...baseShop, status: "SUSPENDED" } },
    { installation: null }, { installation: { ...baseInstallation, status: "REVOKED" } },
    { installation: { ...baseInstallation, credentialVersion: 5 } },
    { installation: { ...baseInstallation, shopId: "foreign" } },
  ]) {
    const { service, calls } = makeService(option);
    await assert.rejects(() => service.read(principal, new URLSearchParams()), RecoveryListIntegrityError);
    assert.equal(calls.some(({ operation }) => operation === "count" || operation === "page"), false);
  }
});

test("a corrupt foreign-Shop customer relationship fails closed without exposing their identity", async () => {
  const { service } = makeService({ rows: [{ ...recovery, customer: { ...recovery.customer, shopId: "foreign" } }] });
  await assert.rejects(() => service.read(principal, new URLSearchParams()), RecoveryListIntegrityError);
});

test("the output schema rejects unknown fields, unbounded arrays and wrong pagination flags", async () => {
  const { service } = makeService();
  const result = await service.read(principal, new URLSearchParams());
  assert.equal(isRecoveryListResponse({ ...result, shopId: "foreign" }), false);
  assert.equal(isRecoveryListResponse({ ...result, hasNext: true }), false);
  assert.equal(isRecoveryListResponse({ ...result, items: [
    { ...result.items[0], checkoutUrl: "https://secret.example" },
  ] }), false);
  assert.equal(isRecoveryListResponse({ ...result, items: Array(51).fill(result.items[0]) }), false);
});
