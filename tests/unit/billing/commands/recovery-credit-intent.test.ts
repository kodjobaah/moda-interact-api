import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  BillingOperationKind,
  BillingOperationState,
  BillingPlanKind,
  MerchantPricingPlanKind,
  MerchantPricingUsagePricingMode,
  Prisma,
  SubscriptionProjectionStatus,
  type BillingOperation,
} from "@prisma/client";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import {
  RecoveryCreditPurchaseCommandError,
  RecoveryCreditPurchaseCommandService,
} from "../../../../src/billing/commands/recovery-credit-purchase-command.service.js";
import { RecoveryCreditIntentPersistence } from "../../../../src/billing/commands/recovery-credit-intent.js";
import { recoveryCreditPurchaseFingerprint } from "../../../../src/billing/commands/recurring-command-primitives.js";

type IntentDatabase = ConstructorParameters<typeof RecoveryCreditIntentPersistence>[0];
type FixtureOperation = BillingOperation;
type FakeSubscription = {
  id: string;
  shopId: string;
  planId: string;
  status: SubscriptionProjectionStatus;
  providerSubscriptionId: string | null;
  billingPeriodId: string | null;
  cancelAtPeriodEnd: boolean;
  plan: { id: string; kind: BillingPlanKind; shopifyPlanHandle: string; active: boolean };
  billingPeriod: {
    id: string; shopId: string; subscriptionId: string; planId: string; status: string;
  } | null;
};

function fixture() {
  const principal: WooInstallationPrincipal = {
    installationId: "install-a", shopId: "shop-a", credentialVersion: 1,
    canonicalSiteUrl: "https://a.example.test",
  };
  const state = {
    shop: {
      id: principal.shopId, domain: principal.canonicalSiteUrl,
      platform: "WOOCOMMERCE", shopifyShopId: null as string | null,
      status: "ACTIVE", onboardingCompleted: true,
    },
    subscription: {
      id: "subscription-a", shopId: principal.shopId, planId: "plan-a",
      status: SubscriptionProjectionStatus.ACTIVE,
      billingPeriodId: null, providerSubscriptionId: null, cancelAtPeriodEnd: false,
      plan: { id: "plan-a", kind: BillingPlanKind.FREE, shopifyPlanHandle: "free-handle", active: true },
      billingPeriod: null,
    } as FakeSubscription,
    catalogue: { id: "catalogue-a", planKind: MerchantPricingPlanKind.FREE as MerchantPricingPlanKind, isActive: true, currency: "USD" },
    bundle: {
      id: "bundle-a", merchantPricingPlanId: "catalogue-a", adminLabel: " Bronze ",
      creditsGrantedPerUnit: 25, pricingMode: MerchantPricingUsagePricingMode.FIXED as MerchantPricingUsagePricingMode,
      fixedUnitAmountMinor: 1999, currency: "USD",
    },
    pending: false,
    existing: null as FixtureOperation | null,
    purchases: [] as Array<Record<string, unknown>>,
    operations: [] as FixtureOperation[],
    forceCreateError: null as Error | null,
    inTransaction: false,
    transactionCount: 0,
  };
  const events: string[] = [];
  const transaction = {
    $queryRaw: async (statement: Prisma.Sql) => {
      const sql = statement.strings.join("");
      if (sql.includes('"commerce"."Shop"')) events.push("lock.shop");
      else if (sql.includes('"billing"."Subscription"')) events.push("lock.subscription");
      else events.push("lock.provider-reference");
      return [];
    },
    shop: { findUnique: async (query: { where: { id: string } }) => {
      events.push("read.shop");
      return query.where.id === state.shop.id ? state.shop : null;
    } },
    subscription: { findUnique: async (query: { where: { shopId: string } }) => {
      events.push("read.subscription");
      return query.where.shopId === state.subscription.shopId ? state.subscription : null;
    } },
    merchantPricingPlan: { findUnique: async (query: { where: { shopifyPlanHandle: string } }) => {
      events.push("read.catalogue");
      return query.where.shopifyPlanHandle === state.subscription.plan.shopifyPlanHandle ? state.catalogue : null;
    } },
    merchantPricingUsageEvent: { findUnique: async (query: { where: { id: string } }) => {
      events.push("read.bundle");
      return query.where.id === state.bundle.id ? state.bundle : null;
    } },
    billingOperation: {
      findUnique: async (query: { where: { id?: string; shopId_requestKey?: { shopId: string; requestKey: string } } }) => {
        events.push("read.operation");
        if (query.where.id) return state.operations.find((row) => row.id === query.where.id) ?? null;
        if (query.where.shopId_requestKey?.shopId !== state.shop.id) return null;
        return state.existing;
      },
      findFirst: async (query: { where: { providerReference?: string; shopId?: unknown } }) => {
        events.push("read.pending");
        if (query.where.providerReference) return null;
        return state.pending ? { id: "pending-operation" } : null;
      },
      create: async (query: { data: Record<string, unknown> }) => {
        events.push("create.operation");
        if (state.forceCreateError) throw state.forceCreateError;
        const operation = {
          id: `operation-${state.operations.length + 1}`,
          ...query.data,
          requestFingerprint: query.data.requestFingerprint,
        } as unknown as FixtureOperation;
        state.operations.push(operation);
        return operation;
      },
      updateMany: async (query: { where: { id: string }; data: Record<string, unknown> }) => {
        events.push("update.operation");
        const row = state.operations.find((operation) => operation.id === query.where.id);
        if (!row || row.state !== BillingOperationState.INITIATING) return { count: 0 };
        Object.assign(row, query.data);
        return { count: 1 };
      },
    },
    recoveryCreditPurchase: {
      create: async (query: { data: Record<string, unknown> }) => {
        events.push("create.purchase");
        state.purchases.push(query.data);
        return { id: query.data.id };
      },
    },
  };
  const database = {
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>, options?: { isolationLevel: string }) => {
      events.push(`transaction.start:${options?.isolationLevel ?? "default"}`);
      state.transactionCount += 1;
      state.inTransaction = true;
      try { return await callback(transaction); }
      finally { state.inTransaction = false; events.push("transaction.end"); }
    },
  } as unknown as IntentDatabase;
  const persistence = new RecoveryCreditIntentPersistence(database);
  return { principal, state, events, persistence, database };
}

function paid(h: ReturnType<typeof fixture>) {
  h.state.subscription.plan.kind = BillingPlanKind.PAID_METERED;
  h.state.subscription.plan.shopifyPlanHandle = "paid-handle";
  h.state.catalogue.planKind = MerchantPricingPlanKind.PAID_METERED;
  h.state.subscription.providerSubscriptionId = "provider-contract";
  h.state.subscription.billingPeriodId = "period-a";
  h.state.subscription.billingPeriod = {
    id: "period-a", shopId: h.principal.shopId, subscriptionId: "subscription-a",
    planId: "plan-a", status: "OPEN",
  };
}

function replayRow(h: ReturnType<typeof fixture>, amount = h.state.bundle.fixedUnitAmountMinor) {
  return {
    id: "original-operation", shopId: h.principal.shopId,
    kind: BillingOperationKind.ONE_TIME_CHARGE,
    state: BillingOperationState.AWAITING_CONFIRMATION,
    merchantPricingUsageEventId: h.state.bundle.id,
    recoveryCreditPurchaseId: "original-purchase",
    requestFingerprint: new Uint8Array(recoveryCreditPurchaseFingerprint({
      shopId: h.principal.shopId, merchantPricingUsageEventId: h.state.bundle.id,
      quotedAmountMinor: amount, quotedCurrency: h.state.bundle.currency,
    })),
    quotedAmountMinor: amount, quotedCurrency: "USD",
    confirmationUrl: "https://woocommerce.com/checkout/original",
  } as FixtureOperation;
}

async function errorCode(promise: Promise<unknown>, code: string, status = 409) {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof RecoveryCreditPurchaseCommandError && error.code === code && error.statusCode === status,
  );
}

const createIntent = (h: ReturnType<typeof fixture>, requestKey = "key-a", bundleId = "bundle-a") =>
  h.persistence.persistIntent(h.principal, requestKey, bundleId);

test("Free intent locks Shop then Subscription, atomically persists exact charge quote and purchase snapshot", async () => {
  const h = fixture();
  const intent = await createIntent(h);
  assert.equal(intent.replay, false);
  assert.equal(intent.canonicalSiteUrl, h.principal.canonicalSiteUrl);
  assert.equal(intent.bundleLabel, "Bronze");
  assert.deepEqual(h.events.slice(0, 5), [
    "transaction.start:ReadCommitted", "lock.shop", "read.shop", "lock.subscription", "read.subscription",
  ]);
  assert.deepEqual(h.events.slice(-3), ["create.purchase", "create.operation", "transaction.end"]);
  assert.equal(h.state.transactionCount, 1);
  assert.equal(h.state.inTransaction, false);
  const purchase = h.state.purchases[0]!;
  assert.equal(purchase.shopId, h.principal.shopId);
  assert.equal(purchase.planId, "plan-a");
  assert.equal(purchase.billingPeriodId, null);
  assert.equal(purchase.providerSubscriptionIdSnapshot, null);
  assert.equal(purchase.status, "REQUESTED");
  assert.equal(purchase.provider, "WOOCOMMERCE");
  assert.equal(purchase.creditsGranted, 25);
  assert.equal(purchase.currentAmount, 0);
  assert.equal(purchase.reservedAmount, 0);
  assert.equal(purchase.providerPriceSnapshot, Prisma.DbNull);
  assert.equal(intent.operation.kind, BillingOperationKind.ONE_TIME_CHARGE);
  assert.equal(intent.operation.state, BillingOperationState.INITIATING);
  assert.equal(intent.operation.requestKey, "key-a");
  assert.equal(intent.operation.recoveryCreditPurchaseId, purchase.id);
  assert.equal(intent.operation.quotedAmountMinor, 1999);
  assert.equal(intent.operation.quotedCurrency, "USD");
  assert.deepEqual(Buffer.from(intent.operation.requestFingerprint), recoveryCreditPurchaseFingerprint({
    shopId: h.principal.shopId, merchantPricingUsageEventId: h.state.bundle.id,
    quotedAmountMinor: 1999, quotedCurrency: "USD",
  }));
});

test("paid plan snapshots the open period and provider reference, including scheduled cancellation", async () => {
  const h = fixture(); paid(h);
  h.state.subscription.cancelAtPeriodEnd = true;
  const intent = await createIntent(h);
  assert.equal(intent.replay, false);
  assert.equal(h.state.purchases[0]?.billingPeriodId, "period-a");
  assert.equal(h.state.purchases[0]?.providerSubscriptionIdSnapshot, "provider-contract");
  h.state.subscription.billingPeriod!.status = "CLOSED";
  await errorCode(createIntent(h, "next-key"), "top_up_purchase_unavailable");
  h.state.subscription.billingPeriod!.status = "OPEN";
  h.state.subscription.billingPeriod!.shopId = "other-shop";
  await errorCode(createIntent(h, "another-key"), "top_up_purchase_unavailable");
  assert.equal(h.state.operations.length, 1);
});

test("wrong tenant, wrong domain, inactive shop or incomplete onboarding fail before purchase", async () => {
  const a = fixture();
  await errorCode(a.persistence.persistIntent({ ...a.principal, shopId: "other-shop" }, "key", "bundle-a"), "billing_shop_invalid");
  await errorCode(a.persistence.persistIntent({ ...a.principal, canonicalSiteUrl: "https://impostor.invalid" }, "key", "bundle-a"), "billing_shop_invalid");
  a.state.shop.status = "DISCONNECTED";
  await errorCode(createIntent(a), "billing_shop_invalid");
  a.state.shop.status = "ACTIVE";
  a.state.shop.onboardingCompleted = false;
  await errorCode(createIntent(a), "billing_not_initialized");
  assert.equal(a.state.purchases.length, 0);
});

test("inactive and mismatched plans or subscriptions reject the charge", async () => {
  const h = fixture();
  h.state.subscription.status = SubscriptionProjectionStatus.FROZEN;
  await errorCode(createIntent(h), "top_up_purchase_unavailable");
  h.state.subscription.status = SubscriptionProjectionStatus.ACTIVE;
  h.state.subscription.plan.active = false;
  await errorCode(createIntent(h), "top_up_purchase_unavailable");
  h.state.subscription.plan.active = true;
  h.state.catalogue.isActive = false;
  await errorCode(createIntent(h), "top_up_purchase_unavailable");
  h.state.catalogue.isActive = true;
  h.state.catalogue.planKind = MerchantPricingPlanKind.PAID_METERED;
  await errorCode(createIntent(h), "top_up_purchase_unavailable");
  assert.equal(h.state.operations.length, 0);
});

test("stale or foreign catalogue bundle is hidden, malformed offers remain unavailable", async () => {
  const h = fixture();
  await errorCode(createIntent(h, "key", "foreign-bundle"), "top_up_bundle_not_found", 404);
  h.state.bundle.merchantPricingPlanId = "other-catalogue";
  await errorCode(createIntent(h), "top_up_bundle_not_found", 404);
  h.state.bundle.merchantPricingPlanId = "catalogue-a";
  h.state.bundle.pricingMode = MerchantPricingUsagePricingMode.GRADUATED;
  await errorCode(createIntent(h), "top_up_bundle_unavailable");
  h.state.bundle.pricingMode = MerchantPricingUsagePricingMode.FIXED;
  h.state.bundle.fixedUnitAmountMinor = 0;
  await errorCode(createIntent(h), "top_up_bundle_unavailable");
  h.state.bundle.fixedUnitAmountMinor = 1999;
  h.state.bundle.currency = "EUR";
  await errorCode(createIntent(h), "top_up_bundle_unavailable");
  h.state.bundle.currency = "USD";
  h.state.bundle.adminLabel = " ";
  await errorCode(createIntent(h), "top_up_bundle_unavailable");
  assert.equal(h.state.operations.length, 0);
});

test("existing pending purchase on the selected bundle prevents a new charge", async () => {
  const h = fixture(); h.state.pending = true;
  await errorCode(createIntent(h), "top_up_purchase_pending");
  assert.equal(h.state.operations.length, 0);
  h.state.pending = false;
  const intent = await createIntent(h);
  assert.equal(intent.replay, false);
  assert.equal(h.state.operations.length, 1);
});

test("existing exact replay bypasses new-purchase eligibility and never inserts a second row", async () => {
  const h = fixture();
  h.state.existing = replayRow(h);
  h.state.subscription.status = SubscriptionProjectionStatus.FROZEN;
  const intent = await createIntent(h);
  assert.equal(intent.replay, true);
  assert.equal(intent.operation.id, "original-operation");
  assert.equal(intent.bundleLabel, "");
  assert.equal(h.state.purchases.length, 0);
  assert.equal(h.state.operations.length, 0);
  assert.equal(h.events.includes("read.catalogue"), false);
});

test("changed quote, event or kind under the same key returns idempotency conflict", async () => {
  const h = fixture(); h.state.existing = replayRow(h);
  await errorCode(createIntent(h, "key", "other-bundle"), "idempotency_conflict");
  h.state.bundle.fixedUnitAmountMinor = 2000;
  await errorCode(createIntent(h), "idempotency_conflict");
  h.state.bundle.fixedUnitAmountMinor = 1999;
  h.state.existing = { ...h.state.existing, kind: BillingOperationKind.CANCEL };
  await errorCode(createIntent(h), "idempotency_conflict");
});

test("duplicate operation uniqueness maps to billing_operation_conflict", async () => {
  const h = fixture();
  h.state.forceCreateError = new Prisma.PrismaClientKnownRequestError("collision", {
    code: "P2002", clientVersion: "6.19.3",
  });
  await errorCode(createIntent(h), "billing_operation_conflict");
});

test("provider sees committed intent, and replay never invokes charge a second time", async () => {
  const h = fixture();
  let calls = 0;
  const provider = { createCharge: async () => {
    h.events.push("provider.call");
    calls += 1;
    assert.equal(h.state.inTransaction, false);
    assert.equal(h.state.operations.length, 1);
    assert.equal(h.state.purchases.length, 1);
    return { id: randomUUID(), confirmation_url: "https://woocommerce.com/checkout/one" };
  } };
  const service = new RecoveryCreditPurchaseCommandService(h.database, provider, "production");
  const first = await service.initiate(h.principal, "key-a", "bundle-a");
  assert.equal(first.state, "AWAITING_CONFIRMATION");
  assert.equal(calls, 1);
  assert.ok(h.events.indexOf("transaction.end") < h.events.indexOf("provider.call"));
  h.state.existing = h.state.operations[0]!;
  const replay = await service.initiate(h.principal, "key-a", "bundle-a");
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
});
