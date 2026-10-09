import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { WooBillingProviderError, type WooChargeRequest } from "../../woocommerce/billing/woo-billing-client.js";
import type { WooBillingConfig } from "../../woocommerce/billing/woo-billing-config.js";
import {
  RecoveryCreditPurchaseCommandError,
  RecoveryCreditPurchaseCommandService,
} from "./recovery-credit-purchase-command.service.js";
import { recoveryCreditPurchaseFingerprint } from "./recurring-command-primitives.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
const siteUrls: string[] = [];
const catalogueHandles: string[] = [];
const catalogueIds: string[] = [];
const billingPlanHandles: string[] = [];
let prisma: PrismaClient | undefined;

function database(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  return prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

function principal(shopId: string, canonicalSiteUrl: string): WooInstallationPrincipal {
  return { installationId: `api004_install_${suffix}`, shopId, canonicalSiteUrl, credentialVersion: 1 };
}

async function featureId(): Promise<string> {
  const db = database();
  const feature = await db.feature.findUnique({ where: { key: "checkout_recovery" } }) ?? await db.feature.create({
    data: {
      key: "checkout_recovery",
      displayName: "Checkout recovery",
      activationMode: "ALWAYS_ENABLED",
      systemRequired: true,
    },
  });
  return feature.id;
}

async function createCatalogue(label: string, kind: "FREE" | "PAID_METERED") {
  const db = database();
  const handle = `api004_${label}_${suffix}`;
  const id = `api004_${label}_${suffix}`;
  catalogueHandles.push(handle);
  catalogueIds.push(id);
  const catalogue = await db.merchantPricingPlan.create({
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
      features: { create: { featureId: await featureId(), configuration: {} } },
    },
  });
  const plan = await db.billingPlan.create({
    data: { shopifyPlanHandle: handle, name: label, kind },
  });
  billingPlanHandles.push(handle);
  return { catalogue, plan };
}

async function createShop(
  label: string,
  planId: string,
  kind: "FREE" | "PAID_METERED",
  providerSubscriptionId: string | null = null,
) {
  const db = database();
  const domain = `https://${label}-${suffix}.api004.invalid`;
  siteUrls.push(domain);
  const shop = await db.shop.create({
    data: { domain, platform: "WOOCOMMERCE", onboardingCompleted: true },
  });
  const subscription = await db.subscription.create({
    data: {
      shopId: shop.id,
      planId,
      status: "ACTIVE",
      providerSubscriptionId,
    },
  });
  let periodId: string | null = null;
  if (kind === "PAID_METERED") {
    const periodStart = new Date(Date.now() - 60_000);
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const period = await db.billingPeriod.create({
      data: {
        shopId: shop.id,
        subscriptionId: subscription.id,
        planId,
        planKindSnapshot: "PAID_METERED",
        includedRecoveryCreditsGranted: 120,
        periodStart,
        periodEnd,
        status: "OPEN",
      },
    });
    await db.subscription.update({ where: { id: subscription.id }, data: { billingPeriodId: period.id } });
    periodId = period.id;
  }
  return { shopId: shop.id, domain, subscriptionId: subscription.id, periodId };
}

async function createBundle(
  catalogueId: string,
  label: string,
  position: number,
  overrides: Record<string, unknown> = {},
) {
  return database().merchantPricingUsageEvent.create({
    data: {
      merchantPricingPlanId: catalogueId,
      eventHandle: `api004_${label}_${suffix}`,
      adminLabel: label,
      creditsGrantedPerUnit: 25,
      position,
      pricingMode: "FIXED",
      currency: "USD",
      fixedUnitAmountMinor: 1999,
      maximumUnitsPerBillingPeriod: null,
      ...overrides,
    } as never,
  });
}

function billingService(
  provider: { createCharge: (body: WooChargeRequest) => Promise<unknown> },
  environment: WooBillingConfig["environment"] = "production",
  db: Pick<PrismaClient, "$transaction"> = database(),
): RecoveryCreditPurchaseCommandService {
  return new RecoveryCreditPurchaseCommandService(db, provider, environment);
}

async function assertCommandError(
  action: Promise<unknown>,
  code: string,
  statusCode: number,
): Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof RecoveryCreditPurchaseCommandError &&
    error.code === code && error.statusCode === statusCode,
  );
}

async function removeFixtures(): Promise<void> {
  if (!prisma) return;
  await prisma.shop.deleteMany({ where: { domain: { in: siteUrls } } });
  await prisma.billingPlan.deleteMany({ where: { shopifyPlanHandle: { in: billingPlanHandles } } });
  await prisma.merchantPricingPlan.deleteMany({ where: { id: { in: catalogueIds } } });
}

after(async () => {
  await removeFixtures();
  if (prisma) await prisma.$disconnect();
});

test("PostgreSQL Free top-up commits exact purchase and operation before /charges and replays without another write", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const { catalogue, plan } = await createCatalogue("free", "FREE");
  const shop = await createShop("free", plan.id, "FREE");
  const bronze = await createBundle(catalogue.id, "Bronze", 0, { maximumUnitsPerBillingPeriod: 0 });
  const silver = await createBundle(catalogue.id, "Silver", 1);
  const requestKey = `free-topup-${suffix}`;
  const chargeId = randomUUID();
  const confirmationUrl = "https://woocommerce.com/checkout/topup";
  const calls: WooChargeRequest[] = [];
  let providerCheckError: unknown;
  const provider = {
    createCharge: async (body: WooChargeRequest) => {
      calls.push(body);
      try {
        const operation = await db.billingOperation.findUnique({
          where: { shopId_requestKey: { shopId: shop.shopId, requestKey } },
        });
        assert.equal(operation?.state, "INITIATING");
        const purchase = await db.recoveryCreditPurchase.findUnique({
          where: { id: operation?.recoveryCreditPurchaseId ?? "missing" },
        });
        assert.equal(purchase?.status, "REQUESTED");
        assert.equal(purchase?.currentAmount, 0);
      } catch (error) {
        providerCheckError = error;
      }
      return { id: chargeId, confirmation_url: confirmationUrl };
    },
  };
  const service = billingService(provider);
  const usageEventCount = await db.usageEvent.count({ where: { shopId: shop.shopId } });
  const result = await service.initiate(principal(shop.shopId, shop.domain), requestKey, bronze.id);
  assert.equal(providerCheckError, undefined);
  assert.deepEqual(result, {
    schemaVersion: 1,
    purchaseId: result.purchaseId,
    operationId: result.operationId,
    state: "AWAITING_CONFIRMATION",
    confirmationUrl,
  });
  assert.deepEqual(calls, [{ name: "Bronze", price: "19.99", return_url:
    `${shop.domain}/wp-admin/admin.php?page=wc-admin&path=%2Fmoda-interact&moda_billing_return=1&operation=${result.operationId}` }]);
  assert.equal("quantity" in calls[0]!, false);

  const operation = await db.billingOperation.findUniqueOrThrow({ where: { id: result.operationId } });
  assert.equal(operation.shopId, shop.shopId);
  assert.equal(operation.kind, "ONE_TIME_CHARGE");
  assert.equal(operation.state, "AWAITING_CONFIRMATION");
  assert.equal(operation.merchantPricingPlanId, null);
  assert.equal(operation.merchantPricingUsageEventId, bronze.id);
  assert.equal(operation.quotedAmountMinor, 1999);
  assert.equal(operation.quotedCurrency, "USD");
  assert.equal(operation.quotedBillingPeriod, null);
  assert.equal(operation.providerReference, chargeId);
  assert.equal(operation.confirmationUrl, confirmationUrl);
  assert.deepEqual(Buffer.from(operation.requestFingerprint), recoveryCreditPurchaseFingerprint({
    shopId: shop.shopId,
    merchantPricingUsageEventId: bronze.id,
    quotedAmountMinor: 1999,
    quotedCurrency: "USD",
  }));

  const purchase = await db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: result.purchaseId } });
  assert.equal(purchase.shopId, shop.shopId);
  assert.equal(purchase.planId, plan.id);
  assert.equal(purchase.billingPeriodId, null);
  assert.equal(purchase.provider, "WOOCOMMERCE");
  assert.equal(purchase.providerReference, null);
  assert.equal(purchase.providerSubscriptionIdSnapshot, null);
  assert.equal(purchase.shopifyPlanHandleSnapshot, null);
  assert.equal(purchase.shopifyEventHandleSnapshot, null);
  assert.equal(purchase.providerUsageQuantityBeforeSnapshot, null);
  assert.equal(purchase.providerUsageQuantityAfterSnapshot, null);
  assert.equal(purchase.providerPurchaseAmount, null);
  assert.equal(purchase.providerPurchaseCurrency, null);
  assert.equal(purchase.providerValuationConfirmedAt, null);
  assert.equal(purchase.providerPriceSnapshot, null);
  assert.equal(purchase.creditsGranted, 25);
  assert.equal(purchase.currentAmount, 0);
  assert.equal(purchase.reservedAmount, 0);
  assert.equal(purchase.status, "REQUESTED");
  assert.equal(purchase.usageEventId, null);
  assert.equal(await db.usageEvent.count({ where: { shopId: shop.shopId } }), usageEventCount);

  assert.deepEqual(await service.initiate(principal(shop.shopId, shop.domain), requestKey, bronze.id), result);
  await db.merchantPricingUsageEvent.update({ where: { id: bronze.id }, data: { fixedUnitAmountMinor: 2000 } });
  await assertCommandError(
    service.initiate(principal(shop.shopId, shop.domain), requestKey, bronze.id),
    "idempotency_conflict",
    409,
  );
  await db.merchantPricingUsageEvent.update({ where: { id: bronze.id }, data: { fixedUnitAmountMinor: 1999 } });
  await db.billingOperation.update({ where: { id: operation.id }, data: { state: "INITIATING" } });
  await assertCommandError(
    service.initiate(principal(shop.shopId, shop.domain), requestKey, bronze.id),
    "billing_operation_in_progress",
    409,
  );
  await db.billingOperation.update({ where: { id: operation.id }, data: { state: "CONFIRMED" } });
  assert.deepEqual(
    await service.initiate(principal(shop.shopId, shop.domain), requestKey, bronze.id),
    { ...result, state: "CONFIRMED" },
  );
  assert.equal((await db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: result.purchaseId } })).status, "REQUESTED");
  await assertCommandError(
    service.initiate(principal(shop.shopId, shop.domain), requestKey, silver.id),
    "idempotency_conflict",
    409,
  );
  await assertCommandError(
    service.initiate(principal(shop.shopId, shop.domain), `second-bronze-${suffix}`, bronze.id),
    "top_up_purchase_pending",
    409,
  );
  const silverResult = await service.initiate(principal(shop.shopId, shop.domain), `silver-${suffix}`, silver.id);
  assert.equal(silverResult.state, "AWAITING_CONFIRMATION");
  assert.equal(calls.length, 2, "a different bundle remains independently purchasable");
  assert.equal(await db.recoveryCreditPurchase.count({ where: { shopId: shop.shopId } }), 2);
});

test("PostgreSQL paid top-up snapshots the current open period and rejects a closed period", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const { catalogue, plan } = await createCatalogue("paid", "PAID_METERED");
  const shop = await createShop("paid", plan.id, "PAID_METERED", `woo-contract-${suffix}`);
  const bundle = await createBundle(catalogue.id, "Paid Bronze", 0);
  const calls: WooChargeRequest[] = [];
  const service = billingService({
    createCharge: async (body) => {
      calls.push(body);
      return { id: randomUUID(), confirmation_url: "https://woocommerce.com/checkout/paid" };
    },
  });
  const result = await service.initiate(principal(shop.shopId, shop.domain), `paid-${suffix}`, bundle.id);
  const purchase = await db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: result.purchaseId } });
  assert.equal(purchase.billingPeriodId, shop.periodId);
  assert.equal(purchase.providerSubscriptionIdSnapshot, `woo-contract-${suffix}`);
  assert.equal(purchase.status, "REQUESTED");
  assert.equal(calls.length, 1);

  await db.billingPeriod.update({ where: { id: shop.periodId! }, data: { status: "CLOSED" } });
  const unavailableBundle = await createBundle(catalogue.id, "Closed Period", 1);
  await assertCommandError(
    service.initiate(principal(shop.shopId, shop.domain), `closed-period-${suffix}`, unavailableBundle.id),
    "top_up_purchase_unavailable",
    409,
  );
  assert.equal(calls.length, 1);
});

test("PostgreSQL catalogue validation hides foreign bundles and rejects non-FIXED or invalid USD offers", {
  skip: !databaseUrl,
}, async () => {
  const { catalogue, plan } = await createCatalogue("eligibility", "FREE");
  const otherCatalogue = await createCatalogue("other", "FREE");
  const shop = await createShop("eligibility", plan.id, "FREE");
  const foreign = await createBundle(otherCatalogue.catalogue.id, "Foreign", 0);
  const invalidBundles = [
    await createBundle(catalogue.id, "Graduated", 0, { pricingMode: "GRADUATED", fixedUnitAmountMinor: null }),
    await createBundle(catalogue.id, "Volume", 1, { pricingMode: "VOLUME", fixedUnitAmountMinor: null }),
    await createBundle(catalogue.id, "No Price", 2, { fixedUnitAmountMinor: null }),
    await createBundle(catalogue.id, "Zero Price", 3, { fixedUnitAmountMinor: 0 }),
    await createBundle(catalogue.id, "No Credits", 4, { creditsGrantedPerUnit: 0 }),
    await createBundle(catalogue.id, "Wrong Currency", 5, { currency: "EUR" }),
    await createBundle(catalogue.id, " ", 6),
  ];
  let calls = 0;
  const service = billingService({
    createCharge: async () => {
      calls += 1;
      return { id: randomUUID(), confirmation_url: "https://woocommerce.com/checkout/eligible" };
    },
  });
  await assertCommandError(
    service.initiate(principal(shop.shopId, shop.domain), `foreign-${suffix}`, foreign.id),
    "top_up_bundle_not_found",
    404,
  );
  for (const [index, bundle] of invalidBundles.entries()) {
    await assertCommandError(
      service.initiate(principal(shop.shopId, shop.domain), `invalid-${index}-${suffix}`, bundle.id),
      "top_up_bundle_unavailable",
      409,
    );
  }
  assert.equal(calls, 0);
  assert.equal(await database().billingOperation.count({ where: { shopId: shop.shopId } }), 0);
  assert.equal(await database().recoveryCreditPurchase.count({ where: { shopId: shop.shopId } }), 0);
});

test("PostgreSQL definite rejection is terminal but retryable with a new key; ambiguous outcomes remain pending", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const { catalogue, plan } = await createCatalogue("provider-outcomes", "FREE");
  const shop = await createShop("provider-outcomes", plan.id, "FREE");
  const rejectedBundle = await createBundle(catalogue.id, "Rejected", 0);
  let rejectCalls = 0;
  const rejecting = billingService({
    createCharge: async () => {
      rejectCalls += 1;
      throw new WooBillingProviderError("DEFINITE_REJECTION", "PROVIDER_REJECTED");
    },
  });
  await assert.rejects(
    rejecting.initiate(principal(shop.shopId, shop.domain), `rejected-${suffix}`, rejectedBundle.id),
    (error: unknown) => error instanceof RecoveryCreditPurchaseCommandError &&
      error.statusCode === 422 && error.code === "billing_provider_rejected",
  );
  const failedOperation = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: shop.shopId, requestKey: `rejected-${suffix}` } },
  });
  const failedPurchase = await db.recoveryCreditPurchase.findUniqueOrThrow({
    where: { id: failedOperation.recoveryCreditPurchaseId! },
  });
  assert.equal(failedOperation.state, "FAILED");
  assert.equal(failedOperation.lastErrorCode, "PROVIDER_REJECTED");
  assert.equal(failedPurchase.status, "REQUESTED");
  assert.equal(failedPurchase.currentAmount, 0);
  assert.equal(rejectCalls, 1);
  await assert.rejects(
    rejecting.initiate(principal(shop.shopId, shop.domain), `rejected-${suffix}`, rejectedBundle.id),
    (error: unknown) => error instanceof RecoveryCreditPurchaseCommandError &&
      error.statusCode === 409 && error.code === "billing_operation_failed" &&
      error.safeProviderCode === "PROVIDER_REJECTED",
  );

  const retry = billingService({
    createCharge: async () => ({ id: randomUUID(), confirmation_url: "https://woocommerce.com/checkout/retry" }),
  });
  const retried = await retry.initiate(principal(shop.shopId, shop.domain), `rejected-retry-${suffix}`, rejectedBundle.id);
  assert.equal(retried.state, "AWAITING_CONFIRMATION");

  const unknownBundle = await createBundle(catalogue.id, "Unknown", 1);
  let unknownCalls = 0;
  const unknown = billingService({
    createCharge: async () => {
      unknownCalls += 1;
      throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_TRANSPORT_ERROR");
    },
  });
  await assertCommandError(
    unknown.initiate(principal(shop.shopId, shop.domain), `unknown-${suffix}`, unknownBundle.id),
    "billing_provider_outcome_unknown",
    502,
  );
  const unknownOperation = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: shop.shopId, requestKey: `unknown-${suffix}` } },
  });
  assert.equal(unknownOperation.state, "OUTCOME_UNKNOWN");
  await assertCommandError(
    retry.initiate(principal(shop.shopId, shop.domain), `unknown-retry-${suffix}`, unknownBundle.id),
    "top_up_purchase_pending",
    409,
  );
  await assertCommandError(
    unknown.initiate(principal(shop.shopId, shop.domain), `unknown-${suffix}`, unknownBundle.id),
    "billing_provider_outcome_unknown",
    409,
  );
  assert.equal(unknownCalls, 1, "ambiguous charge creation is never retried");

  const unsafeBundle = await createBundle(catalogue.id, "Unsafe redirect", 2);
  const unsafe = billingService({
    createCharge: async () => ({ id: randomUUID(), confirmation_url: "https://evil.example/confirm" }),
  });
  await assertCommandError(
    unsafe.initiate(principal(shop.shopId, shop.domain), `unsafe-redirect-${suffix}`, unsafeBundle.id),
    "billing_provider_outcome_unknown",
    502,
  );
  const unsafeOperation = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: shop.shopId, requestKey: `unsafe-redirect-${suffix}` } },
  });
  assert.equal(unsafeOperation.state, "OUTCOME_UNKNOWN");
  assert.equal(unsafeOperation.lastErrorCode, "PROVIDER_REDIRECT_INVALID");
});

test("PostgreSQL same-bundle concurrency serializes, and provider CAS honors a newer durable state", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const { catalogue, plan } = await createCatalogue("concurrent", "FREE");
  const shop = await createShop("concurrent", plan.id, "FREE");
  const bundle = await createBundle(catalogue.id, "Concurrent", 0);
  let signalProviderStart!: () => void;
  let releaseProvider!: () => void;
  const providerStarted = new Promise<void>((resolve) => { signalProviderStart = resolve; });
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let calls = 0;
  const service = billingService({
    createCharge: async () => {
      calls += 1;
      signalProviderStart();
      await providerGate;
      return { id: randomUUID(), confirmation_url: "https://woocommerce.com/checkout/concurrent" };
    },
  });
  const first = service.initiate(principal(shop.shopId, shop.domain), `concurrent-a-${suffix}`, bundle.id);
  await providerStarted;
  await assertCommandError(
    service.initiate(principal(shop.shopId, shop.domain), `concurrent-b-${suffix}`, bundle.id),
    "top_up_purchase_pending",
    409,
  );
  releaseProvider();
  const firstResult = await first;
  assert.equal(firstResult.state, "AWAITING_CONFIRMATION");
  assert.equal(calls, 1);
  assert.equal(await db.billingOperation.count({ where: { shopId: shop.shopId } }), 1);
  assert.equal(await db.recoveryCreditPurchase.count({ where: { shopId: shop.shopId } }), 1);

  const casBundle = await createBundle(catalogue.id, "CAS", 1);
  const casId = randomUUID();
  const casUrl = "https://woocommerce.com/checkout/cas";
  const casService = billingService({
    createCharge: async () => {
      const operation = await db.billingOperation.findUniqueOrThrow({
        where: { shopId_requestKey: { shopId: shop.shopId, requestKey: `cas-${suffix}` } },
      });
      await db.billingOperation.update({
        where: { id: operation.id },
        data: { state: "CONFIRMED", providerReference: casId, confirmationUrl: casUrl },
      });
      return { id: casId, confirmation_url: "https://woocommerce.com/checkout/stale" };
    },
  });
  const casResult = await casService.initiate(principal(shop.shopId, shop.domain), `cas-${suffix}`, casBundle.id);
  assert.equal(casResult.state, "CONFIRMED");
  assert.equal(casResult.confirmationUrl, casUrl);
  const casOperation = await db.billingOperation.findUniqueOrThrow({ where: { id: casResult.operationId } });
  assert.equal(casOperation.providerReference, casId);
  assert.equal(casOperation.confirmationUrl, casUrl);
});

test("PostgreSQL rejects cross-Shop provider charge collisions as ambiguous", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const { catalogue, plan } = await createCatalogue("collision", "FREE");
  const firstShop = await createShop("collision-a", plan.id, "FREE");
  const secondShop = await createShop("collision-b", plan.id, "FREE");
  const bundle = await createBundle(catalogue.id, "Collision", 0);
  const duplicateChargeId = randomUUID();
  let calls = 0;
  const service = billingService({
    createCharge: async () => {
      calls += 1;
      return { id: duplicateChargeId, confirmation_url: "https://woocommerce.com/checkout/collision" };
    },
  });
  await service.initiate(principal(firstShop.shopId, firstShop.domain), `collision-a-${suffix}`, bundle.id);
  await assertCommandError(
    service.initiate(principal(secondShop.shopId, secondShop.domain), `collision-b-${suffix}`, bundle.id),
    "billing_provider_outcome_unknown",
    502,
  );
  const operation = await db.billingOperation.findUniqueOrThrow({
    where: { shopId_requestKey: { shopId: secondShop.shopId, requestKey: `collision-b-${suffix}` } },
  });
  assert.equal(operation.state, "OUTCOME_UNKNOWN");
  assert.equal(operation.lastErrorCode, "PROVIDER_CONTRACT_COLLISION");
  assert.equal(calls, 2);
});

test("PostgreSQL transaction rolls back the purchase when operation creation fails", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const { catalogue, plan } = await createCatalogue("rollback", "FREE");
  const shop = await createShop("rollback", plan.id, "FREE");
  const bundle = await createBundle(catalogue.id, "Rollback", 0);
  const wrappedDatabase = {
    $transaction: (callback: (transaction: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction((transaction) => {
        const wrapped = new Proxy(transaction, {
          get(target, property) {
            if (property === "billingOperation") {
              return new Proxy(target.billingOperation, {
                get(delegate, member) {
                  if (member === "create") return async () => { throw new Error("forced operation insert failure"); };
                  return Reflect.get(delegate, member, delegate) as unknown;
                },
              });
            }
            return Reflect.get(target, property, target) as unknown;
          },
        });
        return callback(wrapped);
      }, options as never),
  } as never;
  let providerCalls = 0;
  const service = billingService({
    createCharge: async () => {
      providerCalls += 1;
      return { id: randomUUID(), confirmation_url: "https://woocommerce.com/checkout/rollback" };
    },
  }, "production", wrappedDatabase);
  await assert.rejects(service.initiate(principal(shop.shopId, shop.domain), `rollback-${suffix}`, bundle.id));
  assert.equal(await db.billingOperation.count({ where: { shopId: shop.shopId } }), 0);
  assert.equal(await db.recoveryCreditPurchase.count({ where: { shopId: shop.shopId } }), 0);
  assert.equal(providerCalls, 0);
});