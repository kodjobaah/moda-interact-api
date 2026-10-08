import assert from "node:assert/strict";
import test from "node:test";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { BillingPresentationError, BillingPresentationReadService } from "./billing-read.service.js";

const principal: WooInstallationPrincipal = {
  installationId: "install_1",
  shopId: "shop_1",
  canonicalSiteUrl: "https://merchant.example",
  credentialVersion: 1,
};

function makeService(row: unknown) {
  const calls: unknown[] = [];
  const service = new BillingPresentationReadService({
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>, options: unknown) => {
      calls.push({ options });
      const transaction = {
        shop: {
          findUnique: async (query: unknown) => {
            calls.push(query);
            return row;
          },
        },
        subscription: { findUnique: async () => null },
        shopEntitlementCounter: { findMany: async () => [] },
        merchantPromotionSelection: { findUnique: async () => null },
        billingOperation: { findMany: async () => [] },
        recoveryCreditPurchase: { findFirst: async () => null, findMany: async () => [] },
        merchantPricingPlan: { findUnique: async () => null },
      };
      return callback(transaction);
    },
  } as never);
  return { service, calls };
}

function activeShop(overrides: Record<string, unknown> = {}) {
  return {
    id: principal.shopId,
    domain: principal.canonicalSiteUrl,
    platform: "WOOCOMMERCE",
    shopifyShopId: null,
    status: "ACTIVE",
    onboardingCompleted: true,
    ...overrides,
  };
}

test("billing read anchors its only Shop lookup to the authenticated principal", async () => {
  const { service, calls } = makeService(activeShop());
  const response = await service.read(principal);
  assert.equal(response.experienceState, "BILLING_ATTENTION");
  assert.deepEqual(calls[0], { options: { isolationLevel: "RepeatableRead" } });
  assert.deepEqual(calls[1], {
    where: { id: principal.shopId },
    select: { id: true, domain: true, platform: true, shopifyShopId: true, status: true, onboardingCompleted: true },
  });
});

test("billing read fails closed for Shop mismatches and incomplete onboarding", async () => {
  for (const row of [
    null,
    activeShop({ id: "other_shop" }),
    activeShop({ domain: "https://other.example" }),
    activeShop({ platform: "SHOPIFY" }),
    activeShop({ shopifyShopId: "shopify_id" }),
    activeShop({ status: "SUSPENDED" }),
  ]) {
    const { service } = makeService(row);
    await assert.rejects(service.read(principal), (error: unknown) =>
      error instanceof BillingPresentationError && error.code === "billing_integrity_invalid",
    );
  }

  const { service } = makeService(activeShop({ onboardingCompleted: false }));
  await assert.rejects(service.read(principal), (error: unknown) =>
    error instanceof BillingPresentationError && error.code === "billing_not_initialized",
  );
});

function projectionService(overrides: Record<string, unknown> = {}) {
  const shopRow = activeShop();
  const subscription = {
    id: "subscription_1",
    shopId: principal.shopId,
    planId: "billing_free",
    status: "ACTIVE",
    billingPeriodId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: null,
    providerCoverageEndAt: null,
    pendingPlanId: null,
    pendingEffectiveAt: null,
    plan: { id: "billing_free", shopifyPlanHandle: "internal_free", kind: "FREE", active: true },
    pendingPlan: null,
    billingPeriod: null,
  };
  const durablePendingCataloguePlan = null;
  const freeOffer = {
    id: "usage_bronze",
    merchantPricingPlanId: "mp_free",
    adminLabel: " Bronze ",
    creditsGrantedPerUnit: 10,
    pricingMode: "FIXED",
    fixedUnitAmountMinor: 1000,
    currency: "USD",
    position: 0,
  };
  const freePlan = {
    id: "mp_free",
    shopifyPlanHandle: "internal_free",
    displayName: "Free",
    planKind: "FREE",
    isActive: true,
    recurringAmountMinor: 0,
    currency: "USD",
    billingPeriod: "EVERY_30_DAYS",
    usageEvents: [
      freeOffer,
      { ...freeOffer, id: "usage_silver", adminLabel: "Silver", position: 1, fixedUnitAmountMinor: 2500 },
      { ...freeOffer, id: "usage_tiered", position: 2, pricingMode: "GRADUATED", fixedUnitAmountMinor: null },
    ],
  };
  const selection = null;
  const counters = [
    { shopId: principal.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 7, committedQuantity: 2, reservedQuantity: 1, refundingQuantity: 0 },
    { shopId: principal.shopId, counter: "PURCHASED_RECOVERY_CREDITS", grantedQuantity: 10, committedQuantity: 1, reservedQuantity: 2, refundingQuantity: 3 },
  ];
  const operations: unknown[] = [];
  const latestPurchase = null;
  const requestedPurchases: unknown[] = [];
  const state = {
    shopRow,
    subscription,
    freePlan,
    counters,
    selection,
    operations,
    latestPurchase,
    requestedPurchases,
    durablePendingCataloguePlan,
    ...overrides,
  } as Record<string, unknown>;
  const queries: unknown[] = [];
  const transaction = {
    shop: { findUnique: async (query: unknown) => { queries.push(query); return state.shopRow; } },
    subscription: { findUnique: async () => state.subscription },
    shopEntitlementCounter: { findMany: async () => state.counters },
    merchantPromotionSelection: { findUnique: async () => state.selection },
    billingOperation: {
      findMany: async (query: unknown) => {
        const where = (query as { where?: { state?: string } }).where;
        if (where?.state === "CONFIRMED") return state.confirmedCancellations ?? [];
        return state.operations;
      },
    },
    recoveryCreditPurchase: {
      findFirst: async () => state.latestPurchase,
      findMany: async () => state.requestedPurchases,
    },
    merchantPricingPlan: {
      findUnique: async (query: unknown) => {
        const where = (query as { where: { id?: string; shopifyPlanHandle?: string } }).where;
        if (where.id) return state.pendingCataloguePlan ?? null;
        if (where.shopifyPlanHandle !== (state.freePlan as { shopifyPlanHandle: string }).shopifyPlanHandle) {
          return state.durablePendingCataloguePlan ?? null;
        }
        return state.currentCataloguePlan ?? state.freePlan;
      },
    },
  };
  const service = new BillingPresentationReadService({
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>, options: unknown) => {
      queries.push({ options });
      return callback(transaction);
    },
  } as never);
  return { service, queries, state };
}

test("Free billing presentation is provider-independent and never mutates capacity", async () => {
  const { service, queries } = projectionService();
  const response = await service.read(principal, new Date("2026-10-08T00:00:00.000Z"));
  assert.equal(response.experienceState, "ACTIVE");
  assert.deepEqual(response.currentPlan, {
    merchantPricingPlanId: "mp_free",
    displayName: "Free",
    planKind: "FREE",
    recurringAmountMinor: 0,
    currency: "USD",
    billingPeriod: "EVERY_30_DAYS",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    cancellationEffectiveAt: null,
  });
  assert.deepEqual(response.capacity.freeLifetime, { granted: 7, committed: 2, reserved: 1, remaining: 4 });
  assert.deepEqual(response.capacity.purchased, { granted: 10, committed: 1, reserved: 2, refunding: 3, available: 4 });
  assert.deepEqual(response.topUps.offers.map(({ merchantPricingUsageEventId, label }) => ({ merchantPricingUsageEventId, label })), [
    { merchantPricingUsageEventId: "usage_bronze", label: "Bronze" },
    { merchantPricingUsageEventId: "usage_silver", label: "Silver" },
  ]);
  assert.equal(response.topUps.purchaseEligible, true);
  assert.deepEqual(queries[0], { options: { isolationLevel: "RepeatableRead" } });
  assert.deepEqual((queries[1] as { where: unknown }).where, { id: principal.shopId });
});

test("one unresolved top-up purchase disables only its own predefined bundle", async () => {
  const purchase = {
    id: "purchase_1",
    shopId: principal.shopId,
    status: "REQUESTED",
    creditsGranted: 10,
    currentAmount: 1000,
    reservedAmount: 0,
    createdAt: new Date("2026-10-07T12:00:00.000Z"),
    activatedAt: null,
    billingOperation: {
      shopId: principal.shopId,
      kind: "ONE_TIME_CHARGE",
      state: "AWAITING_CONFIRMATION",
      recoveryCreditPurchaseId: "purchase_1",
      merchantPricingUsageEventId: "usage_bronze",
      merchantPricingUsageEvent: {
        id: "usage_bronze",
        adminLabel: "Bronze",
        creditsGrantedPerUnit: 10,
        merchantPricingPlanId: "mp_free",
      },
    },
  };
  const { service } = projectionService({ latestPurchase: purchase, requestedPurchases: [purchase] });
  const response = await service.read(principal);
  assert.deepEqual(response.topUps.offers.map((offer) => [
    offer.merchantPricingUsageEventId,
    offer.purchaseEligible,
    offer.unavailableReason,
  ]), [
    ["usage_bronze", false, "PENDING_PURCHASE"],
    ["usage_silver", true, null],
  ]);
  assert.equal(response.topUps.unresolvedPurchases[0]?.merchantPricingUsageEventId, "usage_bronze");
  assert.equal(JSON.stringify(response).includes("internal_free"), false);
  assert.equal(JSON.stringify(response).includes("providerReference"), false);
});

test("paid downgrade uses current allowance without rejecting historical overage", async () => {
  const periodStart = new Date("2026-10-01T00:00:00.000Z");
  const periodEnd = new Date("2026-10-31T00:00:00.000Z");
  const paidSubscription = {
    id: "subscription_paid",
    shopId: principal.shopId,
    planId: "billing_paid",
    status: "ACTIVE",
    billingPeriodId: "period_1",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: "provider-contract-secret",
    providerCoverageEndAt: new Date("2026-12-01T00:00:00.000Z"),
    pendingPlanId: null,
    pendingEffectiveAt: null,
    plan: { id: "billing_paid", shopifyPlanHandle: "internal_paid", kind: "PAID_METERED", active: true },
    pendingPlan: null,
    billingPeriod: {
      id: "period_1",
      shopId: principal.shopId,
      subscriptionId: "subscription_paid",
      planId: "billing_paid",
      shopifyPlanHandleSnapshot: "internal_paid",
      planKindSnapshot: "PAID_METERED",
      includedRecoveryCreditsGranted: 10,
      periodStart,
      periodEnd,
      status: "OPEN",
      entitlementCounters: [{
        shopId: principal.shopId,
        billingPeriodId: "period_1",
        counter: "INCLUDED_RECOVERY_CREDITS",
        grantedQuantity: 10,
        currentAllowanceQuantity: 5,
        committedQuantity: 6,
        reservedQuantity: 1,
        forfeitedQuantity: 0,
      }],
    },
  };
  const paidPlan = {
    id: "mp_paid",
    shopifyPlanHandle: "internal_paid",
    displayName: "Growth",
    planKind: "PAID_METERED",
    isActive: true,
    recurringAmountMinor: 4900,
    currency: "USD",
    billingPeriod: "EVERY_30_DAYS",
    usageEvents: [],
  };
  const { service } = projectionService({
    subscription: paidSubscription,
    freePlan: paidPlan,
    counters: [],
  });
  const response = await service.read(principal, new Date("2026-10-08T00:00:00.000Z"));
  assert.deepEqual(response.capacity.paidIncluded, {
    granted: 10,
    currentAllowance: 5,
    committed: 6,
    reserved: 1,
    forfeited: 0,
    remaining: 0,
  });
  assert.equal(response.currentPlan?.currentPeriodEnd, periodEnd.toISOString());
  assert.equal(JSON.stringify(response).includes("provider-contract-secret"), false);
});

test("FROZEN and scheduled cancellation preserve the Moda period boundary and cancellation boundary", async () => {
  const periodStart = new Date("2026-10-01T00:00:00.000Z");
  const periodEnd = new Date("2026-10-31T00:00:00.000Z");
  const providerCoverageEndAt = new Date("2026-12-15T00:00:00.000Z");
  const subscription = {
    id: "subscription_paid",
    shopId: principal.shopId,
    planId: "billing_paid",
    status: "FROZEN",
    billingPeriodId: "period_1",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: true,
    providerSubscriptionId: "provider-secret",
    providerCoverageEndAt,
    pendingPlanId: null,
    pendingEffectiveAt: null,
    plan: { id: "billing_paid", shopifyPlanHandle: "internal_paid", kind: "PAID_METERED", active: true },
    pendingPlan: null,
    billingPeriod: {
      id: "period_1",
      shopId: principal.shopId,
      subscriptionId: "subscription_paid",
      planId: "billing_paid",
      shopifyPlanHandleSnapshot: "internal_paid",
      planKindSnapshot: "PAID_METERED",
      includedRecoveryCreditsGranted: 10,
      periodStart,
      periodEnd,
      status: "OPEN",
      entitlementCounters: [{
        shopId: principal.shopId,
        billingPeriodId: "period_1",
        counter: "INCLUDED_RECOVERY_CREDITS",
        grantedQuantity: 10,
        currentAllowanceQuantity: null,
        committedQuantity: 2,
        reservedQuantity: 1,
        forfeitedQuantity: 0,
      }],
    },
  };
  const paidPlan = {
    id: "mp_paid",
    shopifyPlanHandle: "internal_paid",
    displayName: "Growth",
    planKind: "PAID_METERED",
    isActive: true,
    recurringAmountMinor: 4900,
    currency: "USD",
    billingPeriod: "EVERY_30_DAYS",
    usageEvents: [],
  };
  const { service } = projectionService({ subscription, freePlan: paidPlan, counters: [] });
  const response = await service.read(principal, new Date("2026-10-08T00:00:00.000Z"));
  assert.equal(response.experienceState, "FROZEN");
  assert.equal(response.capacity.paidIncluded?.remaining, 0);
  assert.equal(response.capacity.paidIncluded?.currentAllowance, 10);
  assert.equal(response.currentPlan?.currentPeriodEnd, periodEnd.toISOString());
  assert.equal(response.currentPlan?.cancellationEffectiveAt, providerCoverageEndAt.toISOString());
  assert.equal(response.surfaces.managePlansAllowed, false);
  assert.equal(response.surfaces.cancelSubscriptionAllowed, false);
});

test("selected active promotion is projected only for a matching target and campaign window", async () => {
  const selection = {
    shopId: principal.shopId,
    promotionalCreditGrant: {
      id: "grant_1",
      shopId: principal.shopId,
      quantity: 12,
      committedQuantity: 3,
      reservedQuantity: 2,
      campaign: {
        id: "campaign_1",
        scope: "GLOBAL",
        targetPlanId: null,
        targetShopId: null,
        startsAt: new Date("2026-10-01T00:00:00.000Z"),
        expiresAt: new Date("2026-11-01T00:00:00.000Z"),
        status: "ACTIVE",
      },
    },
  };
  const { service } = projectionService({ selection });
  const active = await service.read(principal, new Date("2026-10-08T00:00:00.000Z"));
  assert.deepEqual(active.capacity.promotional, { granted: 12, committed: 3, reserved: 2, remaining: 7 });
  const expiredSelection = structuredClone(selection);
  expiredSelection.promotionalCreditGrant.campaign.expiresAt = new Date("2026-10-07T00:00:00.000Z");
  const expired = await projectionService({ selection: expiredSelection }).service.read(
    principal,
    new Date("2026-10-08T00:00:00.000Z"),
  );
  assert.deepEqual(expired.capacity.promotional, { granted: 0, committed: 0, reserved: 0, remaining: 0 });
});

test("active Free without its API-001 lifetime grant fails closed", async () => {
  const { service } = projectionService({
    counters: [{
      shopId: principal.shopId,
      counter: "PURCHASED_RECOVERY_CREDITS",
      grantedQuantity: 0,
      committedQuantity: 0,
      reservedQuantity: 0,
      refundingQuantity: 0,
    }],
  });
  await assert.rejects(service.read(principal), (error: unknown) =>
    error instanceof BillingPresentationError && error.code === "billing_integrity_invalid",
  );
});

test("multiple recurring operations and confirmed cancellation lag fail closed or project bounded state", async () => {
  const operation = {
    id: "operation_cancel",
    shopId: principal.shopId,
    kind: "CANCEL",
    state: "AWAITING_CONFIRMATION",
    merchantPricingPlanId: null,
    providerReference: "provider-secret",
    createdAt: new Date("2026-10-08T00:00:00.000Z"),
  };
  const { service } = projectionService({ operations: [operation, { ...operation, id: "operation_extra" }] });
  await assert.rejects(service.read(principal), (error: unknown) =>
    error instanceof BillingPresentationError && error.code === "billing_operation_conflict",
  );

  const paidSubscription = {
    id: "subscription_paid",
    shopId: principal.shopId,
    planId: "billing_paid",
    status: "ACTIVE",
    billingPeriodId: "period_1",
    currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
    cancelAtPeriodEnd: false,
    providerSubscriptionId: "provider-secret",
    providerCoverageEndAt: null,
    pendingPlanId: null,
    pendingEffectiveAt: null,
    plan: { id: "billing_paid", shopifyPlanHandle: "internal_paid", kind: "PAID_METERED", active: true },
    pendingPlan: null,
    billingPeriod: {
      id: "period_1",
      shopId: principal.shopId,
      subscriptionId: "subscription_paid",
      planId: "billing_paid",
      shopifyPlanHandleSnapshot: "internal_paid",
      planKindSnapshot: "PAID_METERED",
      includedRecoveryCreditsGranted: 10,
      periodStart: new Date("2026-10-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-31T00:00:00.000Z"),
      status: "OPEN",
      entitlementCounters: [{
        shopId: principal.shopId,
        billingPeriodId: "period_1",
        counter: "INCLUDED_RECOVERY_CREDITS",
        grantedQuantity: 10,
        currentAllowanceQuantity: null,
        committedQuantity: 1,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      }],
    },
  };
  const paidPlan = {
    id: "mp_paid",
    shopifyPlanHandle: "internal_paid",
    displayName: "Growth",
    planKind: "PAID_METERED",
    isActive: true,
    recurringAmountMinor: 4900,
    currency: "USD",
    billingPeriod: "EVERY_30_DAYS",
    usageEvents: [],
  };
  const cancellation = { ...operation, state: "CONFIRMED", providerReference: "provider-secret" };
  const pending = await projectionService({
    subscription: paidSubscription,
    freePlan: paidPlan,
    counters: [{
      shopId: principal.shopId,
      counter: "PURCHASED_RECOVERY_CREDITS",
      grantedQuantity: 0,
      committedQuantity: 0,
      reservedQuantity: 0,
      refundingQuantity: 0,
    }],
    confirmedCancellations: [cancellation],
  }).service.read(principal);
  assert.deepEqual(pending.pendingCancellation, { state: "CONFIRMED" });
  assert.equal(JSON.stringify(pending).includes("provider-secret"), false);

  const awaiting = await projectionService({
    subscription: paidSubscription,
    freePlan: paidPlan,
    counters: [{
      shopId: principal.shopId,
      counter: "PURCHASED_RECOVERY_CREDITS",
      grantedQuantity: 0,
      committedQuantity: 0,
      reservedQuantity: 0,
      refundingQuantity: 0,
    }],
    operations: [{ ...operation, state: "OUTCOME_UNKNOWN" }],
  }).service.read(principal);
  assert.deepEqual(awaiting.pendingCancellation, { state: "OUTCOME_UNKNOWN" });
  assert.equal(JSON.stringify(awaiting).includes("provider-secret"), false);
});

test("one unresolved plan operation projects an opaque pending Moda plan", async () => {
  const operation = {
    id: "operation_switch",
    shopId: principal.shopId,
    kind: "PLAN_SWITCH",
    state: "AWAITING_CONFIRMATION",
    merchantPricingPlanId: "mp_growth",
    providerReference: "provider-secret",
    createdAt: new Date("2026-10-08T00:00:00.000Z"),
  };
  const target = {
    id: "mp_growth",
    displayName: "Growth",
    recurringAmountMinor: 4900,
    currency: "USD",
    billingPeriod: "EVERY_30_DAYS",
  };
  const { service } = projectionService({ operations: [operation], pendingCataloguePlan: target });
  const response = await service.read(principal);
  assert.deepEqual(response.pendingPlan, {
    merchantPricingPlanId: "mp_growth",
    displayName: "Growth",
    recurringAmountMinor: 4900,
    currency: "USD",
    billingPeriod: "EVERY_30_DAYS",
    state: "AWAITING_CONFIRMATION",
  });
  assert.equal(JSON.stringify(response).includes("provider-secret"), false);
});

test("operation intent that disagrees with durable pending plan fails closed", async () => {
  const periodStart = new Date("2026-10-01T00:00:00.000Z");
  const periodEnd = new Date("2026-10-31T00:00:00.000Z");
  const subscription = {
    id: "subscription_paid",
    shopId: principal.shopId,
    planId: "billing_paid",
    status: "ACTIVE",
    billingPeriodId: "period_1",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: "provider-secret",
    providerCoverageEndAt: null,
    pendingPlanId: "billing_pending",
    pendingEffectiveAt: periodEnd,
    plan: { id: "billing_paid", shopifyPlanHandle: "internal_paid", kind: "PAID_METERED", active: true },
    pendingPlan: { id: "billing_pending", shopifyPlanHandle: "internal_pending", kind: "PAID_METERED", active: true },
    billingPeriod: {
      id: "period_1",
      shopId: principal.shopId,
      subscriptionId: "subscription_paid",
      planId: "billing_paid",
      shopifyPlanHandleSnapshot: "internal_paid",
      planKindSnapshot: "PAID_METERED",
      includedRecoveryCreditsGranted: 10,
      periodStart,
      periodEnd,
      status: "OPEN",
      entitlementCounters: [{
        shopId: principal.shopId,
        billingPeriodId: "period_1",
        counter: "INCLUDED_RECOVERY_CREDITS",
        grantedQuantity: 10,
        currentAllowanceQuantity: null,
        committedQuantity: 1,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      }],
    },
  };
  const paidPlan = {
    id: "mp_paid",
    shopifyPlanHandle: "internal_paid",
    displayName: "Growth",
    planKind: "PAID_METERED",
    isActive: true,
    recurringAmountMinor: 4900,
    currency: "USD",
    billingPeriod: "EVERY_30_DAYS",
    usageEvents: [],
  };
  const operationPlan = {
    id: "mp_operation_target",
    displayName: "Operation target",
    recurringAmountMinor: 5900,
    currency: "USD",
    billingPeriod: "EVERY_30_DAYS",
  };
  const durablePlan = {
    id: "mp_durable_target",
    displayName: "Durable target",
    recurringAmountMinor: 6900,
    currency: "USD",
    billingPeriod: "EVERY_30_DAYS",
  };
  await assert.rejects(projectionService({
    subscription,
    freePlan: paidPlan,
    counters: [{
      shopId: principal.shopId,
      counter: "PURCHASED_RECOVERY_CREDITS",
      grantedQuantity: 0,
      committedQuantity: 0,
      reservedQuantity: 0,
      refundingQuantity: 0,
    }],
    operations: [{
      id: "operation_switch",
      shopId: principal.shopId,
      kind: "PLAN_SWITCH",
      state: "AWAITING_CONFIRMATION",
      merchantPricingPlanId: operationPlan.id,
      providerReference: "provider-secret",
      createdAt: new Date("2026-10-08T00:00:00.000Z"),
    }],
    pendingCataloguePlan: operationPlan,
    durablePendingCataloguePlan: durablePlan,
  }).service.read(principal), (error: unknown) =>
    error instanceof BillingPresentationError && error.code === "billing_operation_conflict",
  );
});

test("NO_CONTRACT keeps history and plan management available but blocks top-up purchase", async () => {
  const subscription = {
    id: "subscription_empty",
    shopId: principal.shopId,
    planId: null,
    status: "NO_CONTRACT",
    billingPeriodId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: null,
    providerCoverageEndAt: null,
    pendingPlanId: null,
    pendingEffectiveAt: null,
    plan: null,
    pendingPlan: null,
    billingPeriod: null,
  };
  const { service } = projectionService({ subscription, counters: [] });
  const response = await service.read(principal);
  assert.equal(response.experienceState, "NO_CONTRACT");
  assert.deepEqual(response.surfaces, {
    usageHistoryAllowed: true,
    purchaseHistoryAllowed: true,
    managePlansAllowed: true,
    cancelSubscriptionAllowed: false,
  });
  assert.equal(response.topUps.configured, false);
  assert.equal(response.topUps.purchaseEligible, false);
});