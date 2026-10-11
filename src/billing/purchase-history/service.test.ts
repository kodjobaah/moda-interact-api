import assert from "node:assert/strict";
import test from "node:test";
import { WooPurchaseHistoryReadService } from "./service.js";
import { projectPurchase } from "./projection.js";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";

const principal: WooInstallationPrincipal = {
  installationId: "installation-1", shopId: "shop-1", canonicalSiteUrl: "https://merchant.example/", credentialVersion: 1,
};
const createdAt = new Date("2026-10-10T13:00:00.000Z");
const purchase = {
  id: "purchase-1", status: "ACTIVE", createdAt, activatedAt: createdAt,
  creditsGranted: 3, currentAmount: 2, reservedAmount: 1,
  providerReference: "secret-woo-contract", providerValuationConfirmedAt: createdAt,
  providerPurchaseAmount: { toString: () => "150.00" }, providerPurchaseCurrency: "USD",
  refundAttemptedAt: null,
  plan: { name: "Free" },
  billingOperation: {
    shopId: "shop-1", recoveryCreditPurchaseId: "purchase-1", kind: "ONE_TIME_CHARGE",
    merchantPricingUsageEvent: { adminLabel: "Gold Top Up" },
  },
  refunds: [],
};

function setup(overrides: { shop?: unknown; rows?: unknown[]; count?: number } = {}) {
  const queries: Array<{ name: string; args: unknown }> = [];
  const shop = overrides.shop === undefined
    ? { id: "shop-1", domain: "https://merchant.example/", platform: "WOOCOMMERCE", shopifyShopId: null,
        status: "ACTIVE", onboardingCompleted: true }
    : overrides.shop;
  const tx = {
    shop: { findUnique: async (args: unknown) => { queries.push({ name: "shop", args }); return shop; } },
    recoveryCreditPurchase: {
      count: async (args: unknown) => { queries.push({ name: "count", args }); return overrides.count ?? 1; },
      findMany: async (args: unknown) => { queries.push({ name: "findMany", args }); return overrides.rows ?? [purchase]; },
    },
  };
  const service = new WooPurchaseHistoryReadService({
    $transaction: async (fn: (arg: unknown) => unknown, opts: unknown) => {
      queries.push({ name: "transaction", args: opts }); return fn(tx);
    },
  } as never);
  return { service, queries };
}

test("Woo purchase history is shop/provider-scoped and uses one repeatable read with exact Orders link", async () => {
  const { service, queries } = setup();
  const history = await service.read(principal, { filter: "ACTIVE", page: 1, pageSize: 5 });
  assert.equal(history.total, 1);
  assert.equal(history.page, 1);
  assert.deepEqual(history.refundRequest, {
    method: "WOOCOMMERCE_ORDERS", url: "https://woocommerce.com/my-account/orders/",
  });
  assert.deepEqual(history.purchases[0], {
    id: "purchase-1", status: "ACTIVE", createdAt: createdAt.toISOString(), activatedAt: createdAt.toISOString(),
    bundleLabel: "Gold Top Up", planName: "Free", creditsGranted: 3,
    currentAmount: 2, reservedAmount: 1, availableAmount: 1, heldForRefundAmount: 0,
    refundEligible: true, refundUnavailableReason: null, refundAttempted: false,
    latestRefund: null, completedRefund: null, originalProviderPurchase: { amount: "150.00", currency: "USD" },
  });
  assert.deepEqual(queries[0]?.args, { isolationLevel: "RepeatableRead" });
  assert.deepEqual((queries[2]?.args as { where: unknown }).where, {
    shopId: "shop-1", provider: "WOOCOMMERCE", status: "ACTIVE",
  });
  assert.equal(JSON.stringify(history).includes("secret-woo-contract"), false);
  assert.equal(JSON.stringify(history).includes("shopifyPlanHandle"), false);
  assert.equal(queries.some(({ name }) => name.includes("update") || name.includes("create")), false);
});

test("pagination clamps out-of-range page and ALL never broadens shop/provider scope", async () => {
  const { service, queries } = setup({ count: 12, rows: [] });
  const result = await service.read(principal, { filter: "ALL", page: 900, pageSize: 5 });
  assert.equal(result.page, 3);
  assert.equal(result.totalPages, 3);
  assert.deepEqual((queries[2]?.args as { where: unknown }).where, { shopId: "shop-1", provider: "WOOCOMMERCE" });
  assert.deepEqual((queries[3]?.args as { skip: number; take: number }).skip, 10);
  assert.deepEqual((queries[3]?.args as { skip: number; take: number }).take, 5);
});

test("history is denied when principal shop does not match current Woo tenant", async () => {
  const { service, queries } = setup({ shop: { id: "shop-1", domain: "https://another.example/",
    platform: "WOOCOMMERCE", shopifyShopId: null, status: "ACTIVE", onboardingCompleted: true } });
  await assert.rejects(() => service.read(principal, { filter: "ALL", page: 1, pageSize: 5 }),
    { code: "billing_integrity_invalid" });
  assert.equal(queries.some(({ name }) => name === "count"), false);
});

test("refundAttempted cannot be re-opened by a rejected provider refund", () => {
  const rejected = { status: "REJECTED", reason: "WOO_VENDOR_REFUND_REJECTED", finalCreditQuantity: 1,
    providerAmount: null, providerCurrency: null, createdAt, completedAt: null };
  const history = projectPurchase({ ...purchase, refundAttemptedAt: createdAt, refunds: [rejected] } as never, principal.shopId);
  assert.equal(history.refundEligible, false);
  assert.equal(history.refundUnavailableReason, "REFUND_ALREADY_ATTEMPTED");
  assert.equal(history.latestRefund?.status, "REJECTED");
  assert.equal(history.availableAmount, 1);
});

test("historical active Woo lot stays eligible independent of current subscription; missing provider evidence fails closed", () => {
  const item = projectPurchase(purchase as never, principal.shopId);
  assert.equal(item.refundEligible, true);
  const unavailable = projectPurchase({ ...purchase, providerValuationConfirmedAt: null } as never, principal.shopId);
  assert.equal(unavailable.refundEligible, false);
  assert.equal(unavailable.refundUnavailableReason, "PROVIDER_EVIDENCE_UNAVAILABLE");
  assert.deepEqual(unavailable.originalProviderPurchase, { amount: "150.00", currency: "USD" });
});

test("WITHDRAWN is never merchant-action eligible and shows held credits", () => {
  const item = projectPurchase({ ...purchase, status: "WITHDRAWN" } as never, principal.shopId);
  assert.equal(item.refundEligible, false);
  assert.equal(item.heldForRefundAmount, 1);
  assert.equal(item.availableAmount, 0);
});
