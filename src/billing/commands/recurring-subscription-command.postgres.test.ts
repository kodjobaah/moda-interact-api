import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { RecurringBillingCommandError, RecurringSubscriptionCommandService } from "./recurring-subscription-command.service.js";
import { WooBillingProviderError } from "../../woocommerce/billing/woo-billing-client.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
const siteUrls: string[] = [];
const planHandles: string[] = [];
const catalogueIds: string[] = [];
let prisma: PrismaClient | undefined;

function database(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  return prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

function principal(shopId: string, canonicalSiteUrl: string): WooInstallationPrincipal {
  return { installationId: `api003_install_${suffix}`, shopId, canonicalSiteUrl, credentialVersion: 1 };
}

async function createCatalogue(label: string, kind: "FREE" | "PAID_METERED", featureId: string) {
  const handle = `api003_${label}_${suffix}`;
  const id = `api003_${label}_${suffix}`;
  planHandles.push(handle);
  catalogueIds.push(id);
  return database().merchantPricingPlan.create({
    data: {
      id,
      shopifyPlanHandle: handle,
      displayName: label,
      planKind: kind,
      isActive: true,
      cataloguePosition: kind === "FREE" ? 0 : 1,
      includedRecoveryCredits: kind === "FREE" ? 10 : 120,
      allowancePeriod: kind === "FREE" ? "LIFETIME" : "EVERY_30_DAYS",
      billingPeriod: "EVERY_30_DAYS",
      recurringAmountMinor: kind === "FREE" ? 0 : 4900,
      currency: "USD",
      features: { create: { featureId, configuration: {} } },
    },
  });
}

async function createShop(
  label: string,
  operationalPlanId: string,
  status: "FREE" | "PAID",
  providerReference?: string,
  subscriptionStatus: "ACTIVE" | "TRIALING" | "FROZEN" = "ACTIVE",
) {
  const domain = `https://${label}-${suffix}.api003.invalid`;
  siteUrls.push(domain);
  const shop = await database().shop.create({
    data: { domain, platform: "WOOCOMMERCE", onboardingCompleted: true },
  });
  await database().subscription.create({
    data: {
      shopId: shop.id,
      planId: operationalPlanId,
      status: subscriptionStatus,
      providerSubscriptionId: status === "PAID" ? providerReference! : null,
    },
  });
  return { shopId: shop.id, domain };
}

async function checkoutFeatureId(): Promise<string> {
  const feature = await database().feature.findUnique({ where: { key: "checkout_recovery" } }) ?? await database().feature.create({
    data: {
      key: "checkout_recovery",
      displayName: "Checkout recovery",
      activationMode: "ALWAYS_ENABLED",
      systemRequired: true,
    },
  });
  return feature.id;
}

async function createFreeFixture(label: string) {
  const catalogue = await createCatalogue(`free_${label}`, "FREE", await checkoutFeatureId());
  const plan = await database().billingPlan.create({
    data: { shopifyPlanHandle: catalogue.shopifyPlanHandle, name: "Free", kind: "FREE" },
  });
  return { ...await createShop(label, plan.id, "FREE"), catalogue };
}

async function removeFixtures(): Promise<void> {
  if (!prisma) return;
  await prisma.shop.deleteMany({ where: { domain: { in: siteUrls } } });
  await prisma.billingPlan.deleteMany({ where: { shopifyPlanHandle: { in: planHandles } } });
  await prisma.merchantPricingPlan.deleteMany({ where: { id: { in: catalogueIds } } });
}

after(async () => {
  await removeFixtures();
  if (prisma) await prisma.$disconnect();
});

test("PostgreSQL recurring create, replay, switch and cancel persist operations without changing subscription projection", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const featureId = await checkoutFeatureId();
  const [freeCatalogue, paidCatalogue, secondPaidCatalogue] = await Promise.all([
    createCatalogue("free", "FREE", featureId),
    createCatalogue("paid", "PAID_METERED", featureId),
    createCatalogue("second_paid", "PAID_METERED", featureId),
  ]);
  const [freePlan, currentPaidPlan] = await Promise.all([
    db.billingPlan.create({ data: { shopifyPlanHandle: freeCatalogue.shopifyPlanHandle, name: "Free", kind: "FREE" } }),
    db.billingPlan.create({ data: { shopifyPlanHandle: paidCatalogue.shopifyPlanHandle, name: "Paid", kind: "PAID_METERED" } }),
  ]);
  const freeShop = await createShop("create", freePlan.id, "FREE");
  const paidShop = await createShop("switch", currentPaidPlan.id, "PAID", "woo_contract_switch");
  const cancelShop = await createShop("cancel", currentPaidPlan.id, "PAID", "woo_contract_cancel");
  const providerCalls: Array<{ kind: string; body?: unknown; reference?: string }> = [];
  let committedStateAtProviderCall: string | null = null;
  const provider = {
    createSubscription: async (body: unknown) => {
      const committedOperation = await db.billingOperation.findUnique({
        where: { shopId_requestKey: { shopId: freeShop.shopId, requestKey: `create-${suffix}` } },
      });
      committedStateAtProviderCall = committedOperation?.state ?? null;
      providerCalls.push({ kind: "create", body });
      return { id: `woo_created_${suffix}`, confirmation_url: "https://woocommerce.com/checkout/created" };
    },
    switchSubscription: async (reference: string, body: unknown) => {
      providerCalls.push({ kind: "switch", reference, body });
      return { id: reference, confirmation_url: "https://woocommerce.com/checkout/switch" };
    },
    cancelSubscription: async (reference: string) => {
      providerCalls.push({ kind: "cancel", reference });
    },
  };
  const service = new RecurringSubscriptionCommandService(db, provider, "production");
  const before = await Promise.all([freeShop, paidShop, cancelShop].map(async ({ shopId }) => ({
    subscription: await db.subscription.findUniqueOrThrow({ where: { shopId } }),
    periods: await db.billingPeriod.count({ where: { shopId } }),
    counters: await db.shopEntitlementCounter.findMany({ where: { shopId }, orderBy: { counter: "asc" } }),
  })));

  await assert.rejects(
    service.create(principal(freeShop.shopId, freeShop.domain), `free-target-${suffix}`, freeCatalogue.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.code === "free_plan_uses_cancellation",
  );
  await assert.rejects(
    service.create(principal(paidShop.shopId, paidShop.domain), `paid-create-${suffix}`, paidCatalogue.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.code === "subscription_create_not_allowed",
  );
  await assert.rejects(
    service.switchPlan(principal(paidShop.shopId, paidShop.domain), `same-plan-${suffix}`, paidCatalogue.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.code === "billing_plan_unchanged",
  );

  await assert.rejects(
    service.create(principal(freeShop.shopId, paidShop.domain), `wrong-tenant-${suffix}`, paidCatalogue.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.code === "billing_shop_invalid",
  );
  assert.equal(await db.billingOperation.count({ where: { shopId: freeShop.shopId } }), 0);

  const created = await service.create(principal(freeShop.shopId, freeShop.domain), `create-${suffix}`, paidCatalogue.id);
  assert.deepEqual({ kind: created.kind, state: created.state, confirmationUrl: created.confirmationUrl }, {
    kind: "SUBSCRIPTION_CREATE",
    state: "AWAITING_CONFIRMATION",
    confirmationUrl: "https://woocommerce.com/checkout/created",
  });
  assert.deepEqual(providerCalls[0], {
    kind: "create",
    body: {
      name: paidCatalogue.displayName,
      price: "49.00",
      billing_period: "month",
      billing_interval: 1,
      return_url: `${freeShop.domain}/wp-admin/admin.php?page=wc-admin&path=%2Fmoda-interact&moda_billing_return=1&operation=${created.operationId}`,
    },
  });
  const createdOperation = await db.billingOperation.findUniqueOrThrow({ where: { id: created.operationId } });
  assert.equal(createdOperation.state, "AWAITING_CONFIRMATION");
  assert.equal(createdOperation.requestFingerprint.byteLength, 32);
  assert.equal(createdOperation.quotedAmountMinor, 4900);
  assert.equal(createdOperation.quotedCurrency, "USD");
  assert.equal(createdOperation.quotedBillingPeriod, "EVERY_30_DAYS");
  assert.equal(createdOperation.providerReference, `woo_created_${suffix}`);
  assert.equal(committedStateAtProviderCall, "INITIATING");

  const replayed = await service.create(principal(freeShop.shopId, freeShop.domain), `create-${suffix}`, paidCatalogue.id);
  assert.deepEqual(replayed, created);
  await db.merchantPricingPlan.update({ where: { id: paidCatalogue.id }, data: { recurringAmountMinor: 4901 } });
  await assert.rejects(
    service.create(principal(freeShop.shopId, freeShop.domain), `create-${suffix}`, paidCatalogue.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.code === "idempotency_conflict",
  );
  await db.merchantPricingPlan.update({ where: { id: paidCatalogue.id }, data: { recurringAmountMinor: 4900 } });
  await assert.rejects(
    service.create(principal(freeShop.shopId, freeShop.domain), `create-${suffix}`, secondPaidCatalogue.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.code === "idempotency_conflict",
  );
  await assert.rejects(
    service.create(principal(freeShop.shopId, freeShop.domain), `another-${suffix}`, paidCatalogue.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.code === "billing_operation_conflict",
  );

  const switched = await service.switchPlan(principal(paidShop.shopId, paidShop.domain), `switch-${suffix}`, secondPaidCatalogue.id);
  assert.equal(switched.kind, "PLAN_SWITCH");
  assert.equal(switched.state, "AWAITING_CONFIRMATION");
  assert.equal(providerCalls[1]?.kind, "switch");
  assert.equal(providerCalls[1]?.reference, "woo_contract_switch");
  const switchOperation = await db.billingOperation.findUniqueOrThrow({ where: { id: switched.operationId } });
  assert.equal(switchOperation.providerReference, "woo_contract_switch");
  assert.equal(switchOperation.quotedAmountMinor, secondPaidCatalogue.recurringAmountMinor);

  const cancelled = await service.cancel(principal(cancelShop.shopId, cancelShop.domain), `cancel-${suffix}`);
  assert.deepEqual({ kind: cancelled.kind, state: cancelled.state, confirmationUrl: cancelled.confirmationUrl }, {
    kind: "CANCEL",
    state: "CONFIRMED",
    confirmationUrl: null,
  });
  assert.deepEqual(providerCalls[2], { kind: "cancel", reference: "woo_contract_cancel" });
  const cancelOperation = await db.billingOperation.findUniqueOrThrow({ where: { id: cancelled.operationId } });
  assert.equal(cancelOperation.state, "CONFIRMED");
  assert.equal(cancelOperation.merchantPricingPlanId, null);
  assert.equal(cancelOperation.quotedAmountMinor, null);
  assert.equal(cancelOperation.quotedCurrency, null);
  assert.equal(cancelOperation.quotedBillingPeriod, null);

  const after = await Promise.all([freeShop, paidShop, cancelShop].map(async ({ shopId }) => ({
    subscription: await db.subscription.findUniqueOrThrow({ where: { shopId } }),
    periods: await db.billingPeriod.count({ where: { shopId } }),
    counters: await db.shopEntitlementCounter.findMany({ where: { shopId }, orderBy: { counter: "asc" } }),
  })));
  assert.deepEqual(after, before, "provider commands must not change Subscription, BillingPeriod or entitlement counters");
  assert.equal(await db.billingOperation.count({ where: { shopId: freeShop.shopId } }), 1);
  assert.equal(await db.billingOperation.count({ where: { shopId: paidShop.shopId } }), 1);
  assert.equal(await db.billingOperation.count({ where: { shopId: cancelShop.shopId } }), 1);
});

test("PostgreSQL serializes different recurring keys before any second provider write", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const shop = await createFreeFixture("concurrent");
  const target = await createCatalogue("concurrent_target", "PAID_METERED", await checkoutFeatureId());
  let signalProviderStart!: () => void;
  let releaseProvider!: () => void;
  const providerStarted = new Promise<void>((resolve) => { signalProviderStart = resolve; });
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let calls = 0;
  const service = new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => {
      calls += 1;
      signalProviderStart();
      await providerGate;
      return { id: `woo_concurrent_${suffix}`, confirmation_url: "https://woocommerce.com/checkout/concurrent" };
    },
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => { throw new Error("unexpected cancel"); },
  }, "production");

  const firstKey = `concurrent-a-${suffix}`;
  const secondKey = `concurrent-b-${suffix}`;
  const commands = [firstKey, secondKey].map((requestKey) =>
    service.create(principal(shop.shopId, shop.domain), requestKey, target.id)
      .then((result) => ({ result, error: null }))
      .catch((error: unknown) => ({ result: null, error })),
  );
  await providerStarted;
  const early = await Promise.race(commands);
  assert.ok(early.error instanceof RecurringBillingCommandError);
  assert.equal(early.error.code, "billing_operation_conflict");
  releaseProvider();
  const outcomes = await Promise.all(commands);
  assert.equal(outcomes.filter((outcome) => outcome.result !== null).length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.error instanceof RecurringBillingCommandError).length, 1);
  assert.equal(calls, 1);
  assert.equal(await db.billingOperation.count({ where: { shopId: shop.shopId } }), 1);
});

test("PostgreSQL concurrent Shops materialize one paid operational BillingPlan", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const target = await createCatalogue("shared_paid_target", "PAID_METERED", await checkoutFeatureId());
  const freePlan = await createCatalogue("shared_paid_free", "FREE", await checkoutFeatureId());
  const operationalFree = await db.billingPlan.create({
    data: { shopifyPlanHandle: freePlan.shopifyPlanHandle, name: "Shared Free", kind: "FREE" },
  });
  const firstShop = await createShop("shared_materialize_a", operationalFree.id, "FREE");
  const secondShop = await createShop("shared_materialize_b", operationalFree.id, "FREE");
  let providerCalls = 0;
  const makeService = () => new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => {
      providerCalls += 1;
      return { id: `woo_shared_plan_${providerCalls}_${suffix}`, confirmation_url: "https://woocommerce.com/checkout/shared" };
    },
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => { throw new Error("unexpected cancel"); },
  }, "production");
  const [first, second] = await Promise.all([
    makeService().create(principal(firstShop.shopId, firstShop.domain), `shared-plan-a-${suffix}`, target.id),
    makeService().create(principal(secondShop.shopId, secondShop.domain), `shared-plan-b-${suffix}`, target.id),
  ]);
  assert.equal(providerCalls, 2);
  assert.equal(await db.billingPlan.count({ where: { shopifyPlanHandle: target.shopifyPlanHandle } }), 1);
  assert.equal(await db.billingOperation.count({ where: { id: { in: [first.operationId, second.operationId] } } }), 2);
  assert.ok(await db.merchantPricingPlan.findUniqueOrThrow({
    where: { id: target.id }, select: { materializedAt: true },
  }).then((catalogue) => catalogue.materializedAt));
});

test("PostgreSQL records definite and ambiguous provider outcomes without retrying writes", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const target = await createCatalogue("failure_target", "PAID_METERED", await checkoutFeatureId());
  const definiteShop = await createFreeFixture("definite");
  const unknownShop = await createFreeFixture("unknown");
  const cancelCatalogue = await createCatalogue("unknown_cancel_current", "PAID_METERED", await checkoutFeatureId());
  const cancelPlan = await db.billingPlan.create({
    data: { shopifyPlanHandle: cancelCatalogue.shopifyPlanHandle, name: "Cancel paid", kind: "PAID_METERED" },
  });
  const cancelShop = await createShop("unknown_cancel", cancelPlan.id, "PAID", `woo_unknown_cancel_${suffix}`);
  let definiteCalls = 0;
  let unknownCalls = 0;
  let cancelCalls = 0;
  const definiteService = new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => {
      definiteCalls += 1;
      throw new WooBillingProviderError("DEFINITE_REJECTION", "PROVIDER_REJECTED");
    },
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => { throw new Error("unexpected cancel"); },
  }, "production");
  const unknownService = new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => {
      unknownCalls += 1;
      throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_TRANSPORT_ERROR");
    },
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => { throw new Error("unexpected cancel"); },
  }, "production");
  const cancelService = new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => { throw new Error("unexpected create"); },
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => {
      cancelCalls += 1;
      throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_SERVER_ERROR");
    },
  }, "production");
  const definiteKey = `definite-${suffix}`;
  const unknownKey = `unknown-${suffix}`;
  const cancelKey = `unknown-cancel-${suffix}`;

  await assert.rejects(
    definiteService.create(principal(definiteShop.shopId, definiteShop.domain), definiteKey, target.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.statusCode === 422 && error.code === "billing_provider_rejected",
  );
  const failed = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: definiteShop.shopId, requestKey: definiteKey } },
  });
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.lastErrorCode, "PROVIDER_REJECTED");
  await assert.rejects(
    definiteService.create(principal(definiteShop.shopId, definiteShop.domain), definiteKey, target.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.statusCode === 409 && error.code === "billing_operation_failed",
  );

  await assert.rejects(
    unknownService.create(principal(unknownShop.shopId, unknownShop.domain), unknownKey, target.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.statusCode === 502 && error.code === "billing_provider_outcome_unknown",
  );
  const unknown = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: unknownShop.shopId, requestKey: unknownKey } },
  });
  assert.equal(unknown.state, "OUTCOME_UNKNOWN");
  assert.equal(unknown.lastErrorCode, "PROVIDER_TRANSPORT_ERROR");
  await assert.rejects(
    unknownService.create(principal(unknownShop.shopId, unknownShop.domain), unknownKey, target.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.statusCode === 409 &&
      error.code === "billing_provider_outcome_unknown" && error.operationId === unknown.id &&
      error.safeProviderCode === "PROVIDER_TRANSPORT_ERROR",
  );
  await assert.rejects(
    cancelService.cancel(principal(cancelShop.shopId, cancelShop.domain), cancelKey),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.statusCode === 502 &&
      error.code === "billing_provider_outcome_unknown",
  );
  const cancelUnknown = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: cancelShop.shopId, requestKey: cancelKey } },
  });
  assert.equal(cancelUnknown.state, "OUTCOME_UNKNOWN");
  assert.equal(cancelUnknown.providerReference, `woo_unknown_cancel_${suffix}`);
  await assert.rejects(
    cancelService.cancel(principal(cancelShop.shopId, cancelShop.domain), cancelKey),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.statusCode === 409 && error.operationId === cancelUnknown.id,
  );
  assert.equal(definiteCalls, 1);
  assert.equal(unknownCalls, 1);
  assert.equal(cancelCalls, 1);
});

test("PostgreSQL rejects cross-Shop provider contract collisions and preserves a newer CAS state", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const target = await createCatalogue("collision_target", "PAID_METERED", await checkoutFeatureId());
  const firstShop = await createFreeFixture("collision_first");
  const secondShop = await createFreeFixture("collision_second");
  const firstService = new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => ({ id: `woo_shared_${suffix}`, confirmation_url: "https://woocommerce.com/checkout/first" }),
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => { throw new Error("unexpected cancel"); },
  }, "production");
  const secondService = new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => ({ id: `woo_shared_${suffix}`, confirmation_url: "https://woocommerce.com/checkout/second" }),
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => { throw new Error("unexpected cancel"); },
  }, "production");
  const firstResult = await firstService.create(principal(firstShop.shopId, firstShop.domain), `collision-a-${suffix}`, target.id);
  await assert.rejects(
    secondService.create(principal(secondShop.shopId, secondShop.domain), `collision-b-${suffix}`, target.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.statusCode === 502 &&
      error.code === "billing_provider_outcome_unknown",
  );
  const collided = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: secondShop.shopId, requestKey: `collision-b-${suffix}` } },
  });
  assert.equal(collided.state, "OUTCOME_UNKNOWN");
  assert.equal(collided.providerReference, null);
  assert.equal(collided.confirmationUrl, null);
  assert.equal(firstResult.confirmationUrl, "https://woocommerce.com/checkout/first");

  const raceShop = await createFreeFixture("cas_race");
  const raceKey = `cas-race-${suffix}`;
  const raceService = new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => {
      const operation = await db.billingOperation.findUniqueOrThrow({
        where: { shopId_requestKey: { shopId: raceShop.shopId, requestKey: raceKey } },
      });
      await db.billingOperation.updateMany({
        where: { id: operation.id, state: "INITIATING" },
        data: { state: "CONFIRMED", providerReference: `woo_race_${suffix}`, confirmationUrl: "https://woocommerce.com/checkout/newer" },
      });
      return { id: `woo_race_${suffix}`, confirmation_url: "https://woocommerce.com/checkout/older" };
    },
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => { throw new Error("unexpected cancel"); },
  }, "production");
  const raceResult = await raceService.create(principal(raceShop.shopId, raceShop.domain), raceKey, target.id);
  assert.equal(raceResult.state, "CONFIRMED");
  assert.equal(raceResult.confirmationUrl, "https://woocommerce.com/checkout/newer");
  const raced = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: raceShop.shopId, requestKey: raceKey } },
  });
  assert.equal(raced.lastErrorCode, null);
});

test("PostgreSQL permits cancellation for a provider-backed FROZEN subscription", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const featureId = await checkoutFeatureId();
  const currentCatalogue = await createCatalogue("frozen_current", "PAID_METERED", featureId);
  const currentPlan = await db.billingPlan.create({
    data: { shopifyPlanHandle: currentCatalogue.shopifyPlanHandle, name: "Frozen paid", kind: "PAID_METERED" },
  });
  const shop = await createShop("frozen_cancel", currentPlan.id, "PAID", `woo_frozen_${suffix}`, "FROZEN");
  let cancelledReference: string | undefined;
  const service = new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => { throw new Error("unexpected create"); },
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async (reference: string) => { cancelledReference = reference; },
  }, "production");
  const result = await service.cancel(principal(shop.shopId, shop.domain), `frozen-cancel-${suffix}`);
  assert.equal(result.state, "CONFIRMED");
  assert.equal(cancelledReference, `woo_frozen_${suffix}`);
  const subscription = await db.subscription.findUniqueOrThrow({ where: { shopId: shop.shopId } });
  assert.equal(subscription.status, "FROZEN");
  assert.equal(subscription.cancelAtPeriodEnd, false);
  assert.equal(subscription.providerSubscriptionId, `woo_frozen_${suffix}`);
});

test("PostgreSQL rejects unsafe create redirects and switched contract identities as ambiguous", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const featureId = await checkoutFeatureId();
  const target = await createCatalogue("unsafe_target", "PAID_METERED", featureId);
  const redirectShop = await createFreeFixture("unsafe_redirect");
  const redirectService = new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => ({ id: `woo_unsafe_${suffix}`, confirmation_url: "https://attacker.invalid/confirm" }),
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => { throw new Error("unexpected cancel"); },
  }, "production");
  const redirectKey = `unsafe-redirect-${suffix}`;
  await assert.rejects(
    redirectService.create(principal(redirectShop.shopId, redirectShop.domain), redirectKey, target.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.statusCode === 502 &&
      error.code === "billing_provider_outcome_unknown" && error.safeProviderCode === "PROVIDER_REDIRECT_INVALID",
  );
  const unsafeCreate = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: redirectShop.shopId, requestKey: redirectKey } },
  });
  assert.equal(unsafeCreate.state, "OUTCOME_UNKNOWN");
  assert.equal(unsafeCreate.providerReference, null);
  assert.equal(unsafeCreate.confirmationUrl, null);

  const current = await createCatalogue("mismatch_current", "PAID_METERED", featureId);
  const currentPlan = await db.billingPlan.create({
    data: { shopifyPlanHandle: current.shopifyPlanHandle, name: "Mismatch current", kind: "PAID_METERED" },
  });
  const switchShop = await createShop("switch_mismatch", currentPlan.id, "PAID", `woo_expected_${suffix}`);
  const switchKey = `switch-mismatch-${suffix}`;
  const switchService = new RecurringSubscriptionCommandService(db, {
    createSubscription: async () => { throw new Error("unexpected create"); },
    switchSubscription: async () => ({ id: `woo_other_${suffix}`, confirmation_url: "https://woocommerce.com/checkout/switch" }),
    cancelSubscription: async () => { throw new Error("unexpected cancel"); },
  }, "production");
  await assert.rejects(
    switchService.switchPlan(principal(switchShop.shopId, switchShop.domain), switchKey, target.id),
    (error: unknown) => error instanceof RecurringBillingCommandError && error.statusCode === 502 &&
      error.safeProviderCode === "PROVIDER_CONTRACT_MISMATCH",
  );
  const mismatch = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: switchShop.shopId, requestKey: switchKey } },
  });
  assert.equal(mismatch.state, "OUTCOME_UNKNOWN");
  assert.equal(mismatch.providerReference, `woo_expected_${suffix}`);
  assert.equal(mismatch.confirmationUrl, null);
});