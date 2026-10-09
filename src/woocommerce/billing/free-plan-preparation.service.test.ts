import assert from "node:assert/strict";
import test from "node:test";
import { BillingPlanKind, MerchantPricingAllowancePeriod, MerchantPricingPlanKind, Prisma } from "@prisma/client";
import { FreePlanConfigurationUnavailableError } from "./initial-free-activation.service.js";
import { WooFreePlanPreparationService } from "./free-plan-preparation.service.js";

const checkoutFeature = {
  featureId: "feature-checkout",
  configuration: null,
  feature: { key: "checkout_recovery", systemRequired: true },
};
const catalogue = {
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
  features: [checkoutFeature],
};
const operational = {
  id: "billing-free",
  kind: BillingPlanKind.FREE,
  active: true,
  shopifyPlanHandle: catalogue.shopifyPlanHandle,
};

function makeDatabase(options: {
  catalogues?: unknown[];
  existing?: unknown;
  policy?: unknown;
  purposes?: unknown[];
  createError?: unknown;
  raceWinner?: unknown;
} = {}) {
  const events: string[] = [];
  const writes: Array<{ model: string; args: unknown }> = [];
  let planLookups = 0;
  const database = {
    merchantPricingPlan: {
      findMany: async () => { events.push("catalogue.read"); return options.catalogues ?? [catalogue]; },
      updateMany: async (args: unknown) => {
        events.push("catalogue.markMaterialized");
        writes.push({ model: "catalogue.markMaterialized", args });
        return { count: 1 };
      },
    },
    platformBillingPolicy: {
      findUnique: async () => {
        events.push("policy.read");
        return "policy" in options ? options.policy : { lifetimeFreeRecoveryAllowance: 7 };
      },
    },
    billingPlan: {
      findUnique: async () => {
        events.push("operational.read");
        planLookups += 1;
        return planLookups > 1 ? (options.raceWinner ?? options.existing ?? null) : (options.existing ?? null);
      },
      create: async (args: unknown) => {
        events.push("operational.create");
        if (options.createError) throw options.createError;
        writes.push({ model: "operational.create", args });
        return operational;
      },
    },
    merchantKnowledgePurposeDataFormat: {
      findMany: async () => { events.push("knowledge.read"); return options.purposes ?? []; },
    },
  };
  return { database: database as never, events, writes };
}

async function prepare(database: never, requireFirstGrantPolicy = true) {
  return new WooFreePlanPreparationService().prepare(database, requireFirstGrantPolicy);
}

test("materialises the global Free plan before any Shop transaction, copying features", async () => {
  const { database, events, writes } = makeDatabase();
  const result = await prepare(database);
  assert.deepEqual(result, {
    catalogueId: catalogue.id,
    operationalPlanId: operational.id,
    shopifyPlanHandle: catalogue.shopifyPlanHandle,
  });
  const create = writes.find((item) => item.model === "operational.create")?.args as { data: unknown } | undefined;
  assert.ok(create);
  assert.deepEqual(create.data, {
    shopifyPlanHandle: catalogue.shopifyPlanHandle,
    name: "Free",
    kind: BillingPlanKind.FREE,
    active: true,
    shopifyUsageEventHandle: null,
    includedRecoveryConversationAllowance: null,
    recoveryCreditPackEnabled: false,
    recoveryCreditsPerPack: null,
    shopifyRecoveryCreditPackEventHandle: null,
    features: { create: [{ featureId: checkoutFeature.featureId, enabled: true, configuration: Prisma.JsonNull }] },
  });
  assert.deepEqual(events, ["catalogue.read", "policy.read", "operational.read", "operational.create", "catalogue.markMaterialized"]);
});

test("missing first-grant policy fails before global materialisation", async () => {
  const { database, events, writes } = makeDatabase({ policy: null });
  await assert.rejects(prepare(database), { reason: "free_recovery_policy_invalid" });
  assert.deepEqual(events, ["catalogue.read", "policy.read"]);
  assert.deepEqual(writes, []);
});

test("invalid first-grant policies fail closed", async () => {
  for (const lifetimeFreeRecoveryAllowance of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { database } = makeDatabase({ policy: { lifetimeFreeRecoveryAllowance } });
    await assert.rejects(prepare(database), { reason: "free_recovery_policy_invalid" });
  }
});

test("existing Shop may reuse its counter without requiring a policy at preparation", async () => {
  const { database, events } = makeDatabase({ policy: null, existing: operational });
  await prepare(database, false);
  assert.equal(events.includes("policy.read"), false);
});

test("zero and multiple Free catalogue rows fail before materialisation", async () => {
  for (const [catalogues, reason] of [
    [[], "free_catalogue_missing"],
    [[catalogue, { ...catalogue, id: "other-free" }], "multiple_free_catalogue_plans"],
  ] as const) {
    const { database, writes } = makeDatabase({ catalogues: [...catalogues] });
    await assert.rejects(prepare(database), { reason });
    assert.deepEqual(writes, []);
  }
});

test("invalid Free catalogue economics and status fail closed", async () => {
  const invalid = [
    { isActive: false },
    { allowancePeriod: "EVERY_30_DAYS" },
    { recurringAmountMinor: 1 },
    { shopifyRecoveryUsageEventHandle: "shopify-usage" },
    { includedRecoveryCredits: -1 },
    { includedRecoveryCredits: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const change of invalid) {
    const { database } = makeDatabase({ catalogues: [{ ...catalogue, ...change }] });
    await assert.rejects(prepare(database), { reason: "free_catalogue_invalid" });
  }
});

test("missing or unresolved required checkout features prevent new materialisation", async () => {
  for (const features of [
    [{ featureId: "another", configuration: null, feature: { key: "other", systemRequired: false } }],
    [{ featureId: "missing", configuration: null, feature: null }],
  ]) {
    const { database } = makeDatabase({ catalogues: [{ ...catalogue, features }] });
    await assert.rejects(prepare(database), { reason: "free_feature_configuration_invalid" });
  }
});

test("merchant knowledge must be valid and reference active purpose/format pairs", async () => {
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
  const mapping = { ...catalogue, features: [checkoutFeature, knowledge] };
  const inactive = makeDatabase({ catalogues: [mapping] });
  await assert.rejects(prepare(inactive.database), { reason: "free_feature_configuration_invalid" });
  const active = makeDatabase({
    catalogues: [mapping],
    purposes: [{ purpose: { key: "FAQ" }, dataFormat: { key: "WEB_PAGE" } }],
  });
  assert.equal((await prepare(active.database)).operationalPlanId, operational.id);
  assert.equal(active.events.includes("knowledge.read"), true);
  const duplicate = makeDatabase({ catalogues: [{ ...catalogue, features: [checkoutFeature, knowledge, knowledge] }] });
  await assert.rejects(prepare(duplicate.database), FreePlanConfigurationUnavailableError);
});

test("active operational Free plan is reused without rematerialising features", async () => {
  const { database, events, writes } = makeDatabase({ existing: operational });
  await prepare(database);
  assert.equal(events.includes("operational.create"), false);
  assert.equal(writes.some((item) => item.model === "catalogue.markMaterialized"), true);
});

test("inactive or non-Free operational plans are rejected", async () => {
  for (const existing of [{ ...operational, active: false }, { ...operational, kind: BillingPlanKind.PAID_METERED }]) {
    const { database } = makeDatabase({ existing });
    await assert.rejects(prepare(database), { reason: "operational_free_plan_invalid" });
  }
});

test("global concurrent materialisation reuses the validated unique winner", async () => {
  const collision = new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6.19.3" });
  const { database, events } = makeDatabase({ createError: collision, raceWinner: operational });
  assert.equal((await prepare(database)).operationalPlanId, operational.id);
  assert.equal(events.filter((event) => event === "operational.read").length, 2);
});

test("missing or invalid materialisation race winner fails closed", async () => {
  const collision = new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6.19.3" });
  for (const [winner, reason] of [
    [undefined, "activation_retry_exhausted"],
    [{ ...operational, active: false }, "operational_free_plan_invalid"],
  ] as const) {
    const { database } = makeDatabase({ createError: collision, raceWinner: winner });
    await assert.rejects(prepare(database), { reason });
  }
});
