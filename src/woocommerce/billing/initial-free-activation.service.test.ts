import assert from "node:assert/strict";
import test from "node:test";
import { BillingPlanKind, EntitlementCounter, MerchantPricingAllowancePeriod, MerchantPricingPlanKind, Prisma, SubscriptionProjectionStatus } from "@prisma/client";
import {
  FreePlanConfigurationUnavailableError,
  InitialFreeActivationConflictError,
  InitialWooFreeActivationService,
} from "./initial-free-activation.service.js";

const plan = {
  id: "catalogue-free",
  shopifyPlanHandle: "internal-free-handle",
  displayName: "Free",
  planKind: MerchantPricingPlanKind.FREE,
  isActive: true,
  allowancePeriod: MerchantPricingAllowancePeriod.LIFETIME,
  recurringAmountMinor: 0,
  shopifyRecoveryUsageEventHandle: null,
  includedRecoveryCredits: 20,
  materializedAt: null,
  features: [{
    featureId: "feature-checkout",
    configuration: null,
    feature: { key: "checkout_recovery", systemRequired: true },
  }],
};

function makeTransaction(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const writes: Array<{ model: string; args: unknown }> = [];
  const operation = (model: string, result: unknown) => async (args?: unknown) => {
    events.push(model);
    if (args !== undefined) writes.push({ model, args });
    return result;
  };
  const tx = {
    $queryRaw: async () => { events.push("lock"); return []; },
    shop: {
      findUnique: operation("shop.findUnique", { id: "shop-1", onboardingCompleted: false }),
      update: operation("shop.update", {}),
    },
    subscription: {
      findUnique: operation("subscription.findUnique", null),
      upsert: operation("subscription.upsert", { id: "subscription-1" }),
    },
    merchantPricingPlan: {
      findMany: operation("merchantPricingPlan.findMany", [plan]),
      updateMany: operation("merchantPricingPlan.updateMany", { count: 1 }),
    },
    billingPlan: {
      findUnique: operation("billingPlan.findUnique", null),
      create: operation("billingPlan.create", {
        id: "billing-free",
        kind: BillingPlanKind.FREE,
        active: true,
      }),
    },
    merchantKnowledgePurposeDataFormat: {
      findMany: operation("merchantKnowledgePurposeDataFormat.findMany", []),
    },
    shopEntitlementCounter: {
      findUnique: operation("shopEntitlementCounter.findUnique", null),
      create: operation("shopEntitlementCounter.create", { id: "counter-1" }),
    },
    platformBillingPolicy: {
      findUnique: operation("platformBillingPolicy.findUnique", { lifetimeFreeRecoveryAllowance: 7 }),
    },
    ...overrides,
  };
  return { tx: tx as never, events, writes, operation };
}

test("activates a new Shop with an operational Free plan, local subscription, and one lifetime grant", async () => {
  const { tx, events, writes } = makeTransaction();
  const outcome = await new InitialWooFreeActivationService().activate(tx, "shop-1");

  assert.equal(outcome, "ACTIVATED_FREE");
  assert.deepEqual(events.slice(0, 4), ["lock", "shop.findUnique", "lock", "subscription.findUnique"]);
  const planCreate = writes.find((write) => write.model === "billingPlan.create")?.args as { data: Record<string, unknown> };
  assert.deepEqual(planCreate.data, {
    shopifyPlanHandle: "internal-free-handle",
    name: "Free",
    kind: BillingPlanKind.FREE,
    active: true,
    shopifyUsageEventHandle: null,
    includedRecoveryConversationAllowance: null,
    recoveryCreditPackEnabled: false,
    recoveryCreditsPerPack: null,
    shopifyRecoveryCreditPackEventHandle: null,
    features: { create: [{ featureId: "feature-checkout", enabled: true, configuration: Prisma.JsonNull }] },
  });
  const subscription = writes.find((write) => write.model === "subscription.upsert")?.args as { create: Record<string, unknown> };
  assert.equal(subscription.create.status, SubscriptionProjectionStatus.ACTIVE);
  assert.equal(subscription.create.providerSubscriptionId, null);
  assert.equal(subscription.create.billingPeriodId, null);
  assert.equal(subscription.create.observedShopifyPlanHandle, null);
  const counter = writes.find((write) => write.model === "shopEntitlementCounter.create")?.args as { data: Record<string, unknown> };
  assert.deepEqual(counter.data, {
    shopId: "shop-1",
    counter: EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS,
    grantedQuantity: 7,
    committedQuantity: 0,
    reservedQuantity: 0,
    refundingQuantity: 0,
  });
  assert.equal(writes.some((write) => write.model.includes("billingPeriod")), false);
  assert.equal(writes.some((write) => write.model.includes("billingOperation")), false);
});

test("already-onboarded reconnect is a strict billing and entitlement no-op", async () => {
  const { tx, events, writes } = makeTransaction({
    shop: {
      findUnique: async () => ({ id: "shop-1", onboardingCompleted: true }),
      update: async () => { throw new Error("must not update onboarded Shop"); },
    },
    subscription: { findUnique: async () => { throw new Error("must not inspect subscription"); } },
  });
  const outcome = await new InitialWooFreeActivationService().activate(tx, "shop-1");
  assert.equal(outcome, "ALREADY_ONBOARDED");
  assert.deepEqual(events, ["lock"]);
  assert.deepEqual(writes, []);
});

test("never-onboarded Shop with established subscription state fails closed before catalogue access", async () => {
  const { tx, events } = makeTransaction({
    subscription: {
      findUnique: async () => ({
        status: SubscriptionProjectionStatus.NO_CONTRACT,
        planId: null,
        observedShopifyPlanHandle: null,
        billingPeriodId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        providerSubscriptionId: "provider-contract",
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
      }),
    },
    merchantPricingPlan: { findMany: async () => { throw new Error("must not read catalogue"); } },
  });
  await assert.rejects(
    new InitialWooFreeActivationService().activate(tx, "shop-1"),
    InitialFreeActivationConflictError,
  );
  assert.deepEqual(events, ["lock", "shop.findUnique", "lock"]);
});

test("an existing lifetime counter is authoritative and does not require policy or get rewritten", async () => {
  const existingCounter = {
    id: "counter-existing",
    grantedQuantity: 7,
    committedQuantity: 3,
    reservedQuantity: 2,
    refundingQuantity: 1,
    version: 4,
  };
  const { tx, writes } = makeTransaction({
    shopEntitlementCounter: {
      findUnique: async () => existingCounter,
      create: async () => { throw new Error("must not create a second counter"); },
    },
    platformBillingPolicy: {
      findUnique: async () => { throw new Error("policy is only needed for a first grant"); },
    },
  });
  await new InitialWooFreeActivationService().activate(tx, "shop-1");
  assert.equal(writes.some((write) => write.model === "shopEntitlementCounter.create"), false);
  assert.equal(writes.some((write) => write.model === "shopEntitlementCounter.update"), false);
});

test("invalid Free catalogue cardinality fails closed", async () => {
  const { tx } = makeTransaction({ merchantPricingPlan: { findMany: async () => [] } });
  await assert.rejects(
    new InitialWooFreeActivationService().activate(tx, "shop-1"),
    FreePlanConfigurationUnavailableError,
  );
});

test("multiple Free catalogue records fail closed instead of selecting arbitrarily", async () => {
  const { tx } = makeTransaction({
    merchantPricingPlan: { findMany: async () => [plan, { ...plan, id: "second-free-plan" }] },
  });
  await assert.rejects(
    new InitialWooFreeActivationService().activate(tx, "shop-1"),
    FreePlanConfigurationUnavailableError,
  );
});

test("inactive, non-lifetime, recurring, metered, or unsafe-credit Free catalogue fails closed", async () => {
  const invalidPlans = [
    { ...plan, isActive: false },
    { ...plan, allowancePeriod: "EVERY_30_DAYS" },
    { ...plan, recurringAmountMinor: 1 },
    { ...plan, shopifyRecoveryUsageEventHandle: "usage-event" },
    { ...plan, includedRecoveryCredits: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const invalidPlan of invalidPlans) {
    const { tx } = makeTransaction({ merchantPricingPlan: { findMany: async () => [invalidPlan] } });
    await assert.rejects(
      new InitialWooFreeActivationService().activate(tx, "shop-1"),
      FreePlanConfigurationUnavailableError,
    );
  }
});

test("Free plan materialisation rejects missing required or unresolved feature mappings", async () => {
  const invalidFeatures = [
    [{ featureId: "optional-feature", configuration: null, feature: { key: "other", systemRequired: false } }],
    [{ featureId: "missing-feature", configuration: null, feature: null }],
  ];
  for (const features of invalidFeatures) {
    const { tx } = makeTransaction({ merchantPricingPlan: { findMany: async () => [{ ...plan, features }] } });
    await assert.rejects(
      new InitialWooFreeActivationService().activate(tx, "shop-1"),
      FreePlanConfigurationUnavailableError,
    );
  }
});

test("Free plan materialisation rejects duplicate or invalid merchant-knowledge mappings", async () => {
  const checkout = plan.features[0]!;
  const knowledge = {
    featureId: "feature-knowledge",
    configuration: {},
    feature: { key: "merchant_knowledge", systemRequired: false },
  };
  const invalidFeatures = [
    [checkout, knowledge, { ...knowledge, featureId: "duplicate-knowledge" }],
    [checkout, knowledge],
  ];
  for (const features of invalidFeatures) {
    const { tx } = makeTransaction({ merchantPricingPlan: { findMany: async () => [{ ...plan, features }] } });
    await assert.rejects(
      new InitialWooFreeActivationService().activate(tx, "shop-1"),
      FreePlanConfigurationUnavailableError,
    );
  }
});

test("Free plan materialisation requires each configured merchant-knowledge pair to be active", async () => {
  const checkout = plan.features[0]!;
  const knowledge = {
    featureId: "feature-knowledge",
    configuration: {
      schemaVersion: 1,
      maxKnowledgeSources: 4,
      maxContentUnitsPerSource: 1000,
      allowedSourceTypes: [{ purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" }],
    },
    feature: { key: "merchant_knowledge", systemRequired: false },
  };
  const features = [checkout, knowledge];
  const catalogue = { ...plan, features };
  const inactive = makeTransaction({
    merchantPricingPlan: { findMany: async () => [catalogue] },
  });
  await assert.rejects(
    new InitialWooFreeActivationService().activate(inactive.tx, "shop-1"),
    FreePlanConfigurationUnavailableError,
  );

  const active = makeTransaction({
    merchantPricingPlan: {
      findMany: async () => [catalogue],
      updateMany: async () => ({ count: 1 }),
    },
    merchantKnowledgePurposeDataFormat: {
      findMany: async () => [{ purpose: { key: "FAQ" }, dataFormat: { key: "WEB_PAGE" } }],
    },
  });
  await new InitialWooFreeActivationService().activate(active.tx, "shop-1");
  assert.ok(active.writes.some((write) => write.model === "billingPlan.create"));
});

test("reuses an active operational Free plan and sets materializedAt only when absent", async () => {
  const calls: string[] = [];
  const { tx, writes } = makeTransaction({
    billingPlan: {
      findUnique: async () => {
        calls.push("find");
        return { id: "existing-free", kind: BillingPlanKind.FREE, active: true };
      },
      create: async () => { throw new Error("must reuse existing operational plan"); },
    },
  });
  await new InitialWooFreeActivationService().activate(tx, "shop-1");
  assert.deepEqual(calls, ["find"]);
  const timestampUpdate = writes.find((write) => write.model === "merchantPricingPlan.updateMany");
  assert.deepEqual(timestampUpdate?.args, {
    where: { shopifyPlanHandle: plan.shopifyPlanHandle, materializedAt: null },
    data: { materializedAt: timestampUpdate && (timestampUpdate.args as { data: { materializedAt: Date } }).data.materializedAt },
  });
  assert.ok((timestampUpdate?.args as { data: { materializedAt: Date } }).data.materializedAt instanceof Date);
  assert.equal(writes.some((write) => write.model === "billingPlan.create"), false);
  const subscription = writes.find((write) => write.model === "subscription.upsert")?.args as { create: { planId: string } };
  assert.equal(subscription.create.planId, "existing-free");
});

test("missing first-grant policy fails before subscription or onboarding writes", async () => {
  const { tx, writes } = makeTransaction({ platformBillingPolicy: { findUnique: async () => null } });
  await assert.rejects(
    new InitialWooFreeActivationService().activate(tx, "shop-1"),
    FreePlanConfigurationUnavailableError,
  );
  assert.equal(writes.some((write) => write.model === "subscription.upsert"), false);
  assert.equal(writes.some((write) => write.model === "shop.update"), false);
});

test("invalid first-grant policy values fail before subscription or onboarding writes", async () => {
  for (const lifetimeFreeRecoveryAllowance of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { tx, writes } = makeTransaction({
      platformBillingPolicy: { findUnique: async () => ({ lifetimeFreeRecoveryAllowance }) },
    });
    await assert.rejects(
      new InitialWooFreeActivationService().activate(tx, "shop-1"),
      FreePlanConfigurationUnavailableError,
    );
    assert.equal(writes.some((write) => write.model === "subscription.upsert"), false);
    assert.equal(writes.some((write) => write.model === "shop.update"), false);
  }
});