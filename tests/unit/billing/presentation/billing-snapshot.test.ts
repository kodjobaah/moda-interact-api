import assert from "node:assert/strict";
import test from "node:test";
import {
  BillingOperationKind,
  BillingOperationState,
  EntitlementCounter,
  type Prisma,
} from "@prisma/client";
import { BillingSnapshotReader } from "../../../../src/billing/presentation/billing-snapshot.reader.js";
import {
  BillingPresentationError,
  BillingPresentationReadService,
} from "../../../../src/billing/presentation/billing-read.service.js";

const shopId = "woo_shop";
const site = "https://woo.example";
const principal = { installationId: "installation_1", shopId, canonicalSiteUrl: site, credentialVersion: 1 };

type Call = { method: string; args: unknown };

function fixture(overrides: { operations?: unknown[]; purchases?: unknown[] } = {}) {
  const calls: Call[] = [];
  const record = (method: string, result: unknown) => async (args: unknown) => {
    calls.push({ method, args });
    return result;
  };
  const transaction = {
    shop: { findUnique: record("shop.findUnique", {
      id: shopId, domain: site, platform: "WOOCOMMERCE", shopifyShopId: null,
      status: "ACTIVE", onboardingCompleted: true,
    }) },
    subscription: { findUnique: record("subscription.findUnique", null) },
    shopEntitlementCounter: { findMany: record("shopEntitlementCounter.findMany", []) },
    merchantPromotionSelection: { findUnique: record("merchantPromotionSelection.findUnique", null) },
    billingOperation: { findMany: record("billingOperation.findMany", overrides.operations ?? []) },
    recoveryCreditPurchase: {
      findFirst: record("recoveryCreditPurchase.findFirst", null),
      findMany: record("recoveryCreditPurchase.findMany", overrides.purchases ?? []),
    },
    merchantPricingPlan: { findUnique: record("merchantPricingPlan.findUnique", null) },
  } as unknown as Prisma.TransactionClient;
  return { calls, transaction, reader: new BillingSnapshotReader(transaction, shopId) };
}

test("shop snapshot lookup is anchored to the authenticated shop and selects only identity/eligibility fields", async () => {
  const { reader, calls } = fixture();
  await reader.readShop();
  assert.deepEqual(calls, [{
    method: "shop.findUnique",
    args: {
      where: { id: shopId },
      select: {
        id: true, domain: true, platform: true, shopifyShopId: true,
        status: true, onboardingCompleted: true,
      },
    },
  }]);
});

test("one snapshot reader uses the same transaction for all six bounded, tenant-scoped core reads", async () => {
  const { reader, calls } = fixture();
  const result = await reader.readCore();
  assert.deepEqual(Object.keys(result), [
    "subscription", "counters", "selection", "recurringOperations", "latestPurchase", "requestedPurchases",
  ]);
  assert.deepEqual(calls.map((call) => call.method), [
    "subscription.findUnique", "shopEntitlementCounter.findMany", "merchantPromotionSelection.findUnique",
    "billingOperation.findMany", "recoveryCreditPurchase.findFirst", "recoveryCreditPurchase.findMany",
  ]);

  const [subscription, counters, selection, operations, latest, requested] = calls.map((call) => call.args) as Array<{
    where: Record<string, unknown>; orderBy?: unknown; take?: number;
    select: Record<string, unknown>;
  }>;
  assert.deepEqual(subscription?.where, { shopId });
  assert.deepEqual(counters?.where, {
    shopId,
    counter: { in: [EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS, EntitlementCounter.PURCHASED_RECOVERY_CREDITS] },
  });
  assert.deepEqual(selection?.where, { shopId });
  assert.deepEqual(operations?.where, {
    shopId,
    kind: { in: [BillingOperationKind.SUBSCRIPTION_CREATE, BillingOperationKind.PLAN_SWITCH, BillingOperationKind.CANCEL] },
    state: { in: [BillingOperationState.INITIATING, BillingOperationState.AWAITING_CONFIRMATION, BillingOperationState.OUTCOME_UNKNOWN] },
  });
  assert.equal(operations?.take, 3);
  assert.deepEqual(operations?.orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
  assert.deepEqual(latest?.where, { shopId });
  assert.deepEqual(latest?.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.equal(requested?.take, 101, "the 101st unresolved purchase must be read to detect overflow");
  assert.deepEqual(requested?.orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
  assert.equal(requested?.where.shopId, shopId);
  assert.equal(requested?.where.status, "REQUESTED");
  assert.deepEqual(requested?.where.OR, [
    { billingOperation: { is: { state: { in: [
      BillingOperationState.INITIATING, BillingOperationState.AWAITING_CONFIRMATION,
      BillingOperationState.OUTCOME_UNKNOWN, BillingOperationState.CONFIRMED,
    ] } } } },
    { billingOperation: { is: null } },
  ]);
  assert.deepEqual(latest?.select, requested?.select, "latest and unresolved purchase use the same relation selection");
  assert.ok("billingOperation" in (latest?.select ?? {}));
  assert.deepEqual((subscription?.select.billingPeriod as { select: {
    entitlementCounters: { where: { counter: string } };
  } }).select.entitlementCounters.where, { counter: "INCLUDED_RECOVERY_CREDITS" });
});

test("conditional catalogue and confirmed-cancellation queries retain their exact bounded selectors", async () => {
  const { reader, calls } = fixture();
  await reader.readCurrentCataloguePlan("operational_handle");
  await reader.readCataloguePlanById("catalogue_pending");
  await reader.readCataloguePlanByHandle("pending_handle");
  await reader.readConfirmedCancellation("provider_reference");
  assert.deepEqual(calls.map((call) => call.method), [
    "merchantPricingPlan.findUnique", "merchantPricingPlan.findUnique",
    "merchantPricingPlan.findUnique", "billingOperation.findMany",
  ]);
  const [current, byId, byHandle, cancel] = calls.map((call) => call.args) as Array<{
    where: Record<string, unknown>; take?: number; orderBy?: unknown; select: Record<string, unknown>;
  }>;
  assert.deepEqual(current?.where, { shopifyPlanHandle: "operational_handle" });
  assert.deepEqual((current?.select.usageEvents as { take: number; orderBy: unknown }).orderBy, [
    { position: "asc" }, { id: "asc" },
  ]);
  assert.equal((current?.select.usageEvents as { take: number }).take, 101);
  assert.deepEqual(byId?.where, { id: "catalogue_pending" });
  assert.deepEqual(byHandle?.where, { shopifyPlanHandle: "pending_handle" });
  assert.deepEqual(cancel?.where, {
    shopId,
    kind: BillingOperationKind.CANCEL,
    state: BillingOperationState.CONFIRMED,
    providerReference: "provider_reference",
  });
  assert.deepEqual(cancel?.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.equal(cancel?.take, 2);
});

test("purchase overflow and conflicting subscription operations are rejected before conditional catalogue lookups", async () => {
  for (const invalid of [
    { purchases: Array.from({ length: 101 }, (_, i) => ({ id: `p_${i}` })) },
    { operations: [{ id: "op_1" }, { id: "op_2" }] },
  ]) {
    const { transaction, calls } = fixture(invalid);
    const service = new BillingPresentationReadService({
      $transaction: async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => {
        assert.deepEqual(options, { isolationLevel: "RepeatableRead" });
        return callback(transaction);
      },
    } as never);
    await assert.rejects(service.read(principal), (error: unknown) =>
      error instanceof BillingPresentationError && error.code === "billing_operation_conflict",
    );
    assert.equal(calls.length, 7, "shop and six core reads are the only queries before overflow validation");
    assert.equal(calls.some((call) => call.method === "merchantPricingPlan.findUnique"), false);
  }
});
