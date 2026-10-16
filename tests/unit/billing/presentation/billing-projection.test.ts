import assert from "node:assert/strict";
import test from "node:test";
import { BillingPresentationError } from "../../../../src/billing/presentation/billing-presentation.contract.js";
import {
  projectBillingPresentation, validateBillingPeriod, validateCancellations,
  validateCore, validateCurrentCatalogue, validatePendingPlans, validateShop,
  type BillingProjectionSnapshot,
} from "../../../../src/billing/presentation/billing-projection.js";

const now = new Date("2026-10-16T12:00:00.000Z");
const principal = {
  installationId: "installation_1", shopId: "shop_1",
  canonicalSiteUrl: "https://store.example", credentialVersion: 1,
};

function snapshot(): BillingProjectionSnapshot {
  // Typed production query results are supplied directly: no Prisma client,
  // transaction, HTTP request, clock global or provider is needed by projection.
  return {
    shop: {
      id: "shop_1", domain: "https://store.example", platform: "WOOCOMMERCE",
      shopifyShopId: null, status: "ACTIVE", onboardingCompleted: true,
    },
    core: {
      subscription: {
        id: "subscription_free", shopId: "shop_1", planId: "billing_free", status: "ACTIVE",
        billingPeriodId: null, currentPeriodStart: null, currentPeriodEnd: null,
        cancelAtPeriodEnd: false, providerSubscriptionId: null, providerCoverageEndAt: null,
        pendingPlanId: null, pendingEffectiveAt: null,
        plan: { id: "billing_free", shopifyPlanHandle: "free", kind: "FREE", active: true },
        pendingPlan: null, billingPeriod: null,
      },
      counters: [
        { shopId: "shop_1", counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 12,
          committedQuantity: 3, reservedQuantity: 2, refundingQuantity: 0 },
        { shopId: "shop_1", counter: "PURCHASED_RECOVERY_CREDITS", grantedQuantity: 20,
          committedQuantity: 4, reservedQuantity: 3, refundingQuantity: 5 },
      ],
      selection: null, recurringOperations: [], latestPurchase: null, requestedPurchases: [],
    },
    currentCataloguePlan: {
      id: "catalogue_free", shopifyPlanHandle: "free", displayName: "Free",
      planKind: "FREE", isActive: true, recurringAmountMinor: 0, currency: "USD",
      billingPeriod: "EVERY_30_DAYS",
      usageEvents: [{
        id: "bundle_1", merchantPricingPlanId: "catalogue_free", adminLabel: " Bronze ",
        pricingMode: "FIXED", fixedUnitAmountMinor: 1000, creditsGrantedPerUnit: 10,
        currency: "USD", position: 0,
      }],
    },
    operationTargetPlan: null,
    durablePendingCataloguePlan: null,
    confirmedCancellation: null,
    validPaidPeriod: false,
  } as BillingProjectionSnapshot;
}

function paidSnapshot(status: "ACTIVE" | "FROZEN" = "ACTIVE"): BillingProjectionSnapshot {
  const state = snapshot();
  const start = new Date("2026-10-01T00:00:00.000Z");
  const end = new Date("2026-11-01T00:00:00.000Z");
  const sub = state.core.subscription!;
  sub.status = status;
  sub.id = "subscription_paid";
  sub.planId = "billing_paid";
  sub.plan = { id: "billing_paid", shopifyPlanHandle: "paid", kind: "PAID_METERED", active: true };
  sub.billingPeriodId = "period_1";
  sub.currentPeriodStart = start;
  sub.currentPeriodEnd = end;
  sub.providerSubscriptionId = "secret-provider-subscription";
  sub.billingPeriod = {
    id: "period_1", shopId: "shop_1", subscriptionId: sub.id, planId: sub.planId,
    shopifyPlanHandleSnapshot: "paid", planKindSnapshot: "PAID_METERED",
    includedRecoveryCreditsGranted: 30, periodStart: start, periodEnd: end, status: "OPEN",
    entitlementCounters: [{
      shopId: "shop_1", billingPeriodId: "period_1", counter: "INCLUDED_RECOVERY_CREDITS",
      grantedQuantity: 30, currentAllowanceQuantity: 25, committedQuantity: 3,
      reservedQuantity: 2, forfeitedQuantity: 4,
    }],
  };
  state.currentCataloguePlan = { ...state.currentCataloguePlan!,
    id: "catalogue_paid", shopifyPlanHandle: "paid", planKind: "PAID_METERED",
    recurringAmountMinor: 4900,
    usageEvents: [],
  };
  state.core.counters = state.core.counters.filter((counter) => counter.counter === "PURCHASED_RECOVERY_CREDITS");
  return state;
}

function evaluate(state: BillingProjectionSnapshot, clock = now) {
  validateShop(state.shop, principal);
  validateCore(state.shop, state.core);
  validateCurrentCatalogue(state.core.subscription, state.currentCataloguePlan);
  validatePendingPlans(state.core.subscription, state.core.recurringOperations,
    state.operationTargetPlan, state.durablePendingCataloguePlan);
  state.validPaidPeriod = validateBillingPeriod(state.shop, state.core.subscription);
  const operation = state.core.recurringOperations.find((entry) => entry.kind === "SUBSCRIPTION_CREATE" || entry.kind === "PLAN_SWITCH");
  validateCancellations(state.core.subscription, state.core.recurringOperations, operation, state.confirmedCancellation);
  return projectBillingPresentation(state, clock);
}

test("pure Free projection preserves lifetime and refund-adjusted purchased balances", () => {
  const result = evaluate(snapshot());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.experienceState, "ACTIVE");
  assert.deepEqual(result.capacity.freeLifetime, { granted: 12, committed: 3, reserved: 2, remaining: 7 });
  assert.deepEqual(result.capacity.purchased, { granted: 20, committed: 4, reserved: 3, refunding: 5, available: 8 });
  assert.equal(result.capacity.paidIncluded, null);
  assert.equal(result.topUps.purchaseEligible, true);
  assert.deepEqual(result.topUps.offers.map(({ label, amountMinor }) => [label, amountMinor]), [["Bronze", 1000]]);
});

test("active promotion is time-bound and expired promotion produces zero capacity", () => {
  const state = snapshot();
  state.core.selection = {
    shopId: "shop_1",
    promotionalCreditGrant: {
      shopId: "shop_1", quantity: 15, committedQuantity: 3, reservedQuantity: 2,
      campaign: {
        id: "campaign_1", scope: "GLOBAL", targetPlanId: null, targetShopId: null,
        status: "ACTIVE", startsAt: new Date("2026-10-01T00:00:00.000Z"),
        expiresAt: new Date("2026-10-17T00:00:00.000Z"),
      },
    },
  } as NonNullable<BillingProjectionSnapshot["core"]["selection"]>;
  assert.deepEqual(evaluate(state).capacity.promotional, { granted: 15, committed: 3, reserved: 2, remaining: 10 });
  assert.deepEqual(evaluate(state, new Date("2026-10-17T00:00:00.000Z")).capacity.promotional,
    { granted: 0, committed: 0, reserved: 0, remaining: 0 });
});

test("paid included allowance preserves forfeiture; frozen capacity is zero and cancellation remains available", () => {
  const active = evaluate(paidSnapshot());
  assert.deepEqual(active.capacity.paidIncluded, {
    granted: 30, currentAllowance: 25, committed: 3, reserved: 2, forfeited: 4, remaining: 16,
  });
  const frozen = evaluate(paidSnapshot("FROZEN"));
  assert.equal(frozen.capacity.paidIncluded?.remaining, 0);
  assert.equal(frozen.topUps.purchaseEligible, false);
  assert.equal(frozen.surfaces.cancelSubscriptionAllowed, true);
  assert.equal(frozen.surfaces.managePlansAllowed, false);
});

test("pending cancellation and confirmed cancellation preserve the existing states", () => {
  const pending = paidSnapshot();
  pending.core.recurringOperations = [{
    id: "cancel_1", shopId: "shop_1", kind: "CANCEL", state: "OUTCOME_UNKNOWN",
    merchantPricingPlanId: null, providerReference: "secret-provider-subscription", createdAt: now,
  }];
  assert.deepEqual(evaluate(pending).pendingCancellation, { state: "OUTCOME_UNKNOWN" });
  const confirmed = paidSnapshot();
  confirmed.confirmedCancellation = [{
    id: "cancel_2", shopId: "shop_1", kind: "CANCEL", state: "CONFIRMED",
    providerReference: "secret-provider-subscription",
  }];
  const response = evaluate(confirmed);
  assert.deepEqual(response.pendingCancellation, { state: "CONFIRMED" });
  assert.equal(JSON.stringify(response).includes("secret-provider-subscription"), false);
});

test("pending plan, cancellation at period end and NO_CONTRACT states are unchanged", () => {
  const pending = paidSnapshot();
  pending.core.recurringOperations = [{
    id: "switch_1", shopId: "shop_1", kind: "PLAN_SWITCH", state: "AWAITING_CONFIRMATION",
    merchantPricingPlanId: "catalogue_next", providerReference: "opaque", createdAt: now,
  }];
  pending.operationTargetPlan = {
    id: "catalogue_next", displayName: "Next", currency: "USD",
    recurringAmountMinor: 5900, billingPeriod: "EVERY_30_DAYS",
  };
  assert.deepEqual(evaluate(pending).pendingPlan, {
    merchantPricingPlanId: "catalogue_next", displayName: "Next", currency: "USD",
    recurringAmountMinor: 5900, billingPeriod: "EVERY_30_DAYS", state: "AWAITING_CONFIRMATION",
  });
  const cancelling = paidSnapshot();
  cancelling.core.subscription!.cancelAtPeriodEnd = true;
  assert.equal(evaluate(cancelling).surfaces.managePlansAllowed, false);
  const noContract = snapshot();
  noContract.core.subscription!.status = "NO_CONTRACT";
  noContract.core.subscription!.planId = null;
  noContract.core.subscription!.plan = null;
  noContract.currentCataloguePlan = null;
  assert.equal(evaluate(noContract).topUps.purchaseEligible, false);
  assert.equal(evaluate(noContract).surfaces.managePlansAllowed, true);
});

test("outstanding purchase disables just its matching usage-event offer", () => {
  const state = snapshot();
  const purchase = {
    id: "purchase_1", shopId: "shop_1", status: "REQUESTED", creditsGranted: 10,
    currentAmount: 10, reservedAmount: 0, createdAt: now, activatedAt: null,
    billingOperation: {
      shopId: "shop_1", kind: "ONE_TIME_CHARGE", state: "AWAITING_CONFIRMATION",
      recoveryCreditPurchaseId: "purchase_1", merchantPricingUsageEventId: "bundle_1",
      merchantPricingUsageEvent: {
        id: "bundle_1", adminLabel: "Bronze", creditsGrantedPerUnit: 10,
        merchantPricingPlanId: "catalogue_free",
      },
    },
  } as BillingProjectionSnapshot["core"]["requestedPurchases"][number];
  state.core.requestedPurchases = [purchase];
  state.core.latestPurchase = purchase;
  const projected = evaluate(state);
  assert.equal(projected.topUps.purchaseEligible, false);
  assert.equal(projected.topUps.offers[0]?.unavailableReason, "PENDING_PURCHASE");
  assert.equal(projected.topUps.unresolvedPurchases.length, 1);
  assert.equal(projected.topUps.latestPurchase?.id, purchase.id);
});

test("pure stage guards reject bad tenant, invalid paid period, conflicting cancellation and invalid purchase", () => {
  const state = snapshot();
  assert.throws(() => validateShop({ ...state.shop, domain: "https://different.example" }, principal),
    (error: unknown) => error instanceof BillingPresentationError && error.code === "billing_integrity_invalid");
  const invalidPaid = paidSnapshot();
  invalidPaid.core.subscription!.billingPeriod!.planId = "another_plan";
  assert.throws(() => validateBillingPeriod(invalidPaid.shop, invalidPaid.core.subscription),
    (error: unknown) => error instanceof BillingPresentationError && error.code === "billing_integrity_invalid");
  const conflicting = paidSnapshot();
  conflicting.confirmedCancellation = [
    { id: "a", shopId: "shop_1", kind: "CANCEL", state: "CONFIRMED", providerReference: "s" },
    { id: "b", shopId: "shop_1", kind: "CANCEL", state: "CONFIRMED", providerReference: "s" },
  ];
  assert.throws(() => evaluate(conflicting),
    (error: unknown) => error instanceof BillingPresentationError && error.code === "billing_operation_conflict");
  const invalidPurchase = snapshot();
  invalidPurchase.core.requestedPurchases = [{
    id: "bad_purchase", shopId: "shop_1", status: "REQUESTED", creditsGranted: 5,
    currentAmount: 5, reservedAmount: 0, createdAt: now, activatedAt: null,
    billingOperation: null,
  }];
  assert.throws(() => evaluate(invalidPurchase),
    (error: unknown) => error instanceof BillingPresentationError && error.code === "billing_integrity_invalid");
});
