import assert from "node:assert/strict";
import test from "node:test";
import {
  BillingPlanKind,
  EntitlementCounter,
  MerchantPricingAllowancePeriod,
  MerchantPricingPlanKind,
  Prisma,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import {
  FreePlanConfigurationUnavailableError,
  InitialFreeActivationConflictError,
  InitialWooFreeActivationService,
  RetryFreeActivationTransactionError,
} from "./initial-free-activation.service.js";

const prepared = {
  catalogueId: "catalogue-free",
  operationalPlanId: "billing-free",
  shopifyPlanHandle: "internal-free-handle",
};
const catalogue = {
  id: prepared.catalogueId,
  shopifyPlanHandle: prepared.shopifyPlanHandle,
  planKind: MerchantPricingPlanKind.FREE,
  isActive: true,
  allowancePeriod: MerchantPricingAllowancePeriod.LIFETIME,
  recurringAmountMinor: 0,
  shopifyRecoveryUsageEventHandle: null,
  includedRecoveryCredits: 20,
};
const billingPlan = {
  id: prepared.operationalPlanId,
  shopifyPlanHandle: prepared.shopifyPlanHandle,
  active: true,
  kind: BillingPlanKind.FREE,
};

function emptyInitialSubscription(providerCoverageEndAt: Date | null) {
  return {
    status: SubscriptionProjectionStatus.NO_CONTRACT,
    planId: null,
    observedShopifyPlanHandle: null,
    billingPeriodId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: null,
    providerCoverageEndAt,
    lastSyncedAt: null,
    lastSyncErrorCode: null,
    lastSyncErrorAt: null,
    pendingShopifyPlanHandle: null,
    pendingPlanId: null,
    pendingEffectiveAt: null,
    nextReconcileAt: null,
    lastProviderLifecycleState: null,
    lastProviderLifecycleEventId: null,
    lastProviderLifecycleEventAt: null,
  };
}

function makeTransaction(options: {
  onboarded?: boolean;
  subscription?: unknown;
  counter?: unknown;
  policy?: unknown;
  catalogues?: unknown[];
  billingPlan?: unknown;
  counterCreateError?: unknown;
} = {}) {
  const events: string[] = [];
  const writes: Array<{ model: string; args: unknown }> = [];
  const operation = (name: string, result: unknown) => async (args?: unknown) => {
    events.push(name);
    if (args !== undefined) writes.push({ model: name, args });
    return result;
  };
  const transaction = {
    $queryRaw: async () => { events.push("lock"); return []; },
    shop: {
      findUnique: operation("shop.findUnique", { id: "shop-1", onboardingCompleted: options.onboarded ?? false }),
      update: operation("shop.update", {}),
    },
    subscription: {
      findUnique: operation("subscription.findUnique", options.subscription ?? null),
      upsert: operation("subscription.upsert", { id: "subscription-1" }),
    },
    merchantPricingPlan: {
      findMany: operation("merchantPricingPlan.findMany", options.catalogues ?? [catalogue]),
    },
    billingPlan: {
      findUnique: operation("billingPlan.findUnique", "billingPlan" in options ? options.billingPlan : billingPlan),
    },
    shopEntitlementCounter: {
      findUnique: operation("counter.findUnique", options.counter ?? null),
      create: async (args: unknown) => {
        events.push("counter.create");
        writes.push({ model: "counter.create", args });
        if (options.counterCreateError) throw options.counterCreateError;
        return { id: "counter-1" };
      },
    },
    platformBillingPolicy: {
      findUnique: operation("policy.findUnique", "policy" in options ? options.policy : { lifetimeFreeRecoveryAllowance: 7 }),
    },
  };
  return { transaction: transaction as never, events, writes };
}

async function activate(transaction: never, plan: typeof prepared | null = prepared) {
  return new InitialWooFreeActivationService().activate(transaction, "shop-1", plan);
}

test("short Shop transaction creates subscription, lifetime grant, and onboarding without global writes", async () => {
  const { transaction, events, writes } = makeTransaction();
  assert.equal(await activate(transaction), "ACTIVATED_FREE");
  assert.deepEqual(events.slice(0, 4), ["lock", "shop.findUnique", "lock", "subscription.findUnique"]);
  assert.equal(events.includes("merchantKnowledgePurposeDataFormat.findMany"), false);
  assert.equal(events.includes("billingPlan.create"), false);
  assert.equal(events.includes("merchantPricingPlan.updateMany"), false);
  const subscription = writes.find((write) => write.model === "subscription.upsert")?.args as
    { create: Record<string, unknown>; update: Record<string, unknown> };
  assert.equal(subscription.create.planId, prepared.operationalPlanId);
  assert.equal(subscription.create.status, SubscriptionProjectionStatus.ACTIVE);
  assert.equal(subscription.create.providerSubscriptionId, null);
  assert.equal(subscription.create.providerCoverageEndAt, null);
  assert.equal(subscription.create.billingPeriodId, null);
  const counter = writes.find((write) => write.model === "counter.create")?.args as { data: unknown };
  assert.deepEqual(counter.data, {
    shopId: "shop-1",
    counter: EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS,
    grantedQuantity: 7,
    committedQuantity: 0,
    reservedQuantity: 0,
    refundingQuantity: 0,
  });
  assert.equal(writes.some((write) => write.model === "shop.update"), true);
});

test("already-onboarded reconnect is a complete Free activation no-op without prepared plan", async () => {
  const { transaction, events, writes } = makeTransaction({ onboarded: true });
  assert.equal(await activate(transaction, null), "ALREADY_ONBOARDED");
  assert.deepEqual(events, ["lock", "shop.findUnique"]);
  assert.equal(writes.some((write) => write.model === "subscription.upsert"), false);
});

test("never-onboarded established subscription fails closed before catalogue recheck", async () => {
  for (const subscription of [
    { ...emptyInitialSubscription(null), providerSubscriptionId: "provider-contract" },
    emptyInitialSubscription(new Date("2026-10-01T00:00:00.000Z")),
  ]) {
    const { transaction, events } = makeTransaction({ subscription });
    await assert.rejects(activate(transaction), InitialFreeActivationConflictError);
    assert.deepEqual(events, ["lock", "shop.findUnique", "lock", "subscription.findUnique"]);
  }
});

test("eligible initial placeholder can activate without erasing provider coverage", async () => {
  const { transaction, writes } = makeTransaction({ subscription: emptyInitialSubscription(null) });
  await activate(transaction);
  const subscription = writes.find((write) => write.model === "subscription.upsert")?.args as
    { create: Record<string, unknown>; update: Record<string, unknown> };
  assert.equal(subscription.update.providerCoverageEndAt, null);
});

test("an existing lifetime counter is authoritative even when policy is missing", async () => {
  const counter = { id: "counter-existing", grantedQuantity: 7, committedQuantity: 3, reservedQuantity: 2, refundingQuantity: 1 };
  const { transaction, writes, events } = makeTransaction({ counter, policy: null });
  await activate(transaction);
  assert.equal(events.includes("policy.findUnique"), false);
  assert.equal(writes.some((write) => write.model === "counter.create"), false);
});

test("first-grant policy must still be valid inside the transaction before Shop writes", async () => {
  for (const policy of [null, { lifetimeFreeRecoveryAllowance: -1 }, { lifetimeFreeRecoveryAllowance: 1.5 }]) {
    const { transaction, writes } = makeTransaction({ policy });
    await assert.rejects(activate(transaction), { reason: "free_recovery_policy_invalid" });
    assert.equal(writes.some((write) => write.model === "subscription.upsert"), false);
    assert.equal(writes.some((write) => write.model === "shop.update"), false);
  }
});

<<<<<<< Updated upstream
test("paid plan materialisation snapshots the operational allowance and feature configuration", async () => {
  const paidPlan = {
    ...plan,
    id: "catalogue-paid",
    shopifyPlanHandle: "internal-paid-handle",
    displayName: "Growth",
    planKind: MerchantPricingPlanKind.PAID_METERED,
    allowancePeriod: MerchantPricingAllowancePeriod.EVERY_30_DAYS,
    billingPeriod: "EVERY_30_DAYS",
    recurringAmountMinor: 4900,
    currency: "USD",
    shopifyRecoveryUsageEventHandle: "usage_growth",
    includedRecoveryCredits: 120,
  };
  const { tx, writes, operation } = makeTransaction({
    billingPlan: {
      findUnique: async () => null,
    },
  });
  (tx as unknown as { billingPlan: { create: (args: unknown) => Promise<unknown> } }).billingPlan.create =
    operation("billingPlan.create", { id: "paid-operational", kind: BillingPlanKind.PAID_METERED, active: true });
  const result = await new InitialWooFreeActivationService().resolvePaidPlan(tx, paidPlan as never);
  assert.equal(result.kind, BillingPlanKind.PAID_METERED);
  const created = writes.find((write) => write.model === "billingPlan.create")?.args as { data: Record<string, unknown> };
  assert.deepEqual(created.data, {
    shopifyPlanHandle: "internal-paid-handle",
    name: "Growth",
    kind: BillingPlanKind.PAID_METERED,
    active: true,
    shopifyUsageEventHandle: "usage_growth",
    includedRecoveryConversationAllowance: 120,
    recoveryCreditPackEnabled: false,
    recoveryCreditsPerPack: null,
    shopifyRecoveryCreditPackEventHandle: null,
    features: { create: [{ featureId: "feature-checkout", enabled: true, configuration: Prisma.JsonNull }] },
  });
  assert.ok(writes.some((write) => write.model === "merchantPricingPlan.updateMany"));
  assert.equal(writes.some((write) => write.model.startsWith("subscription.")), false);
  assert.equal(writes.some((write) => write.model.includes("billingPeriod")), false);
});

test("paid plan materialisation reuses an active operational plan", async () => {
  const paidPlan = {
    ...plan,
    id: "catalogue-paid",
    shopifyPlanHandle: "internal-paid-handle",
    planKind: MerchantPricingPlanKind.PAID_METERED,
    allowancePeriod: MerchantPricingAllowancePeriod.EVERY_30_DAYS,
    billingPeriod: "EVERY_30_DAYS",
    recurringAmountMinor: 4900,
    currency: "USD",
  };
  const { tx, writes } = makeTransaction({
    billingPlan: {
      findUnique: async () => ({ id: "existing-paid", kind: BillingPlanKind.PAID_METERED, active: true }),
      create: async () => { throw new Error("must reuse the active operational plan"); },
    },
  });
  const result = await new InitialWooFreeActivationService().resolvePaidPlan(tx, paidPlan as never);
  assert.equal(result.id, "existing-paid");
  assert.equal(writes.some((write) => write.model === "billingPlan.create"), false);
  assert.ok(writes.some((write) => write.model === "merchantPricingPlan.updateMany"));
});

test("paid plan materialisation rejects invalid catalogue invariants", async () => {
  const paidPlan = {
    ...plan,
    id: "catalogue-paid",
    shopifyPlanHandle: "internal-paid-handle",
    planKind: MerchantPricingPlanKind.PAID_METERED,
    allowancePeriod: MerchantPricingAllowancePeriod.EVERY_30_DAYS,
    billingPeriod: "EVERY_30_DAYS",
    recurringAmountMinor: 4900,
    currency: "USD",
  };
  for (const invalid of [
    { isActive: false },
    { recurringAmountMinor: 0 },
    { includedRecoveryCredits: -1 },
    { currency: "EUR" },
    { billingPeriod: "EVERY_MONTH" },
  ]) {
    const { tx, writes } = makeTransaction();
    await assert.rejects(
      new InitialWooFreeActivationService().resolvePaidPlan(tx, { ...paidPlan, ...invalid } as never),
      { name: "FreePlanConfigurationUnavailableError", reason: "paid_catalogue_invalid" },
    );
    assert.equal(writes.some((write) => write.model === "billingPlan.create"), false);
  }
});
=======
test("missing preparation or changed catalogue after preparation fails closed", async () => {
  const changes = [
    { id: "other-free" },
    { isActive: false },
    { recurringAmountMinor: 1 },
    { allowancePeriod: "EVERY_30_DAYS" },
    { shopifyPlanHandle: "different-handle" },
  ];
  for (const change of changes) {
    const { transaction, writes } = makeTransaction({ catalogues: [{ ...catalogue, ...change }] });
    await assert.rejects(activate(transaction), { reason: "free_catalogue_invalid" });
    assert.equal(writes.some((write) => write.model === "subscription.upsert"), false);
  }
  const { transaction } = makeTransaction();
  await assert.rejects(activate(transaction, null), FreePlanConfigurationUnavailableError);
});

test("multiple Free catalogue rows cannot silently replace the prepared plan", async () => {
  const { transaction } = makeTransaction({ catalogues: [catalogue, { ...catalogue, id: "second" }] });
  await assert.rejects(activate(transaction), { reason: "free_catalogue_invalid" });
});

test("inactive or mismatched operational Free plan cannot activate the merchant", async () => {
  for (const plan of [null, { ...billingPlan, active: false }, { ...billingPlan, kind: BillingPlanKind.PAID_METERED }]) {
    const { transaction, writes } = makeTransaction({ billingPlan: plan });
    await assert.rejects(activate(transaction), { reason: "operational_free_plan_invalid" });
    assert.equal(writes.some((write) => write.model === "subscription.upsert"), false);
  }
});

test("counter uniqueness conflicts remain retryable at the Shop transaction boundary", async () => {
  const conflict = new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6.19.3" });
  const { transaction } = makeTransaction({ counterCreateError: conflict });
  await assert.rejects(activate(transaction), RetryFreeActivationTransactionError);
});
>>>>>>> Stashed changes
