import assert from "node:assert/strict";
import test from "node:test";
import {
  BillingOperationKind,
  BillingOperationState,
  BillingPlanKind,
  Prisma,
  SubscriptionProjectionStatus,
  type BillingOperation,
} from "@prisma/client";
import type { WooInstallationPrincipal } from "../../../../src/woocommerce/installation/authenticator.js";
import {
  FreePlanConfigurationUnavailableError,
  RetryFreeActivationTransactionError,
} from "../../../../src/woocommerce/billing/initial-free-activation.service.js";
import { RecurringBillingCommandError, RecurringSubscriptionCommandService } from "../../../../src/billing/commands/recurring-subscription-command.service.js";
import { recurringRequestFingerprint } from "../../../../src/billing/commands/recurring-command-primitives.js";
import { RecurringIntentPersistence } from "../../../../src/billing/commands/recurring-intent.js";

type Kind = "SUBSCRIPTION_CREATE" | "PLAN_SWITCH" | "CANCEL";

type FixtureOperation = BillingOperation & {
  requestFingerprint: Uint8Array;
};

type SubscriptionFixture = {
  id: string;
  shopId: string;
  planId: string;
  status: string;
  billingPeriodId: string | null;
  cancelAtPeriodEnd: boolean;
  providerSubscriptionId: string | null;
  plan: { id: string; kind: BillingPlanKind; shopifyPlanHandle: string; active: boolean };
};

type CatalogueFixture = {
  id: string;
  displayName: string;
  shopifyPlanHandle: string;
  planKind: string;
  isActive: boolean;
  allowancePeriod: string;
  billingPeriod: string;
  recurringAmountMinor: number;
  currency: string;
  includedRecoveryCredits: number;
  features: unknown[];
};

type IntentDb = ConstructorParameters<typeof RecurringIntentPersistence>[0];
type IntentResolver = ConstructorParameters<typeof RecurringIntentPersistence>[1];

function fixture() {
  const events: string[] = [];
  const principal: WooInstallationPrincipal = {
    shopId: "shop-a", canonicalSiteUrl: "https://merchant.example.test",
    installationId: "installation-a", credentialVersion: 2,
  };
  const state = {
    shop: {
      id: principal.shopId, domain: principal.canonicalSiteUrl,
      platform: "WOOCOMMERCE", shopifyShopId: null as string | null,
      status: "ACTIVE", onboardingCompleted: true,
    },
    subscription: {
      id: "subscription-a", shopId: principal.shopId, planId: "free-plan",
      status: SubscriptionProjectionStatus.ACTIVE,
      billingPeriodId: null, cancelAtPeriodEnd: false,
      providerSubscriptionId: null,
      plan: { id: "free-plan", kind: BillingPlanKind.FREE, shopifyPlanHandle: "free-handle", active: true },
    } as SubscriptionFixture,
    catalogue: {
      id: "paid-plan", displayName: "Growth", shopifyPlanHandle: "growth-handle",
      planKind: "PAID_METERED", isActive: true, allowancePeriod: "EVERY_30_DAYS",
      billingPeriod: "EVERY_30_DAYS", recurringAmountMinor: 4900, currency: "USD",
      includedRecoveryCredits: 100, features: [],
    } as CatalogueFixture,
    existing: null as FixtureOperation | null,
    operations: [] as Array<{ kind: BillingOperationKind; state: BillingOperationState; providerReference: string | null }>,
    currentCatalogueId: "old-paid-plan",
    created: [] as FixtureOperation[],
    transactionCount: 0,
    resolverCount: 0,
    resolverErrors: [] as Error[],
    forceDbError: null as Error | null,
    activeTransaction: false,
  };
  const transaction = {
    $queryRaw: async () => {
      events.push(`lock-${events.filter((event) => event.startsWith("lock-")).length + 1}`);
      return [];
    },
    shop: { findUnique: async () => { events.push("shop.read"); return state.shop; } },
    subscription: { findUnique: async () => { events.push("subscription.read"); return state.subscription; } },
    billingOperation: {
      findUnique: async (args: { where: { id?: string } }) => {
        events.push("operation.read");
        return args.where.id ? state.created.find((o) => o.id === args.where.id) ?? null : state.existing;
      },
      findMany: async () => { events.push("operations.read"); return state.operations; },
      create: async (args: { data: Record<string, unknown> }) => {
        events.push("operation.create");
        const data = args.data;
        const operation = {
          ...data,
          id: `operation-${state.created.length + 1}`,
          merchantPricingPlanId: data.merchantPricingPlanId ?? null,
          providerReference: data.providerReference ?? null,
          quotedAmountMinor: data.quotedAmountMinor ?? null,
          quotedCurrency: data.quotedCurrency ?? null,
          quotedBillingPeriod: data.quotedBillingPeriod ?? null,
          confirmationUrl: null,
          lastErrorCode: null,
        } as unknown as FixtureOperation;
        state.created.push(operation);
        return operation;
      },
      updateMany: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        events.push("operation.update");
        const row = state.created.find((operation) => operation.id === args.where.id);
        if (!row || row.state !== BillingOperationState.INITIATING) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
      findFirst: async () => null,
    },
    merchantPricingPlan: {
      findUnique: async (args: { where: { id?: string; shopifyPlanHandle?: string } }) => {
        events.push("catalogue.read");
        if (args.where.shopifyPlanHandle) return { id: state.currentCatalogueId };
        return args.where.id === state.catalogue.id ? state.catalogue : null;
      },
    },
  };
  const database = {
    $transaction: async (fn: (tx: typeof transaction) => Promise<unknown>, options?: { isolationLevel: string }) => {
      events.push(`transaction.start:${options?.isolationLevel ?? "default"}`);
      state.transactionCount += 1;
      state.activeTransaction = true;
      try {
        if (state.forceDbError) throw state.forceDbError;
        return await fn(transaction);
      } finally {
        state.activeTransaction = false;
        events.push("transaction.end");
      }
    },
  } as unknown as IntentDb;
  const resolver = {
    resolvePaidPlan: async () => {
      events.push("plan.resolve");
      state.resolverCount += 1;
      const error = state.resolverErrors.shift();
      if (error) throw error;
      return { kind: BillingPlanKind.PAID_METERED };
    },
  } as unknown as IntentResolver;
  const persistence = new RecurringIntentPersistence(database, resolver);
  return { state, principal, events, database, resolver, persistence };
}

function asPaid(h: ReturnType<typeof fixture>, reference = "woo-contract") {
  const subscription = h.state.subscription;
  subscription.status = SubscriptionProjectionStatus.ACTIVE;
  subscription.planId = "paid-operational-plan";
  subscription.plan = {
    id: "paid-operational-plan", kind: BillingPlanKind.PAID_METERED,
    shopifyPlanHandle: "old-paid-handle", active: true,
  };
  subscription.providerSubscriptionId = reference;
}

function replayRow(h: ReturnType<typeof fixture>, kind: Kind, planId = "paid-plan", reference = "woo-contract") {
  const fingerprint = recurringRequestFingerprint(kind === "CANCEL"
    ? { kind, shopId: h.principal.shopId, providerReference: reference }
    : {
        kind, shopId: h.principal.shopId,
        ...(kind === "PLAN_SWITCH" ? { providerReference: reference } : {}),
        merchantPricingPlanId: planId,
        quotedAmountMinor: h.state.catalogue.recurringAmountMinor,
        quotedCurrency: h.state.catalogue.currency,
        quotedBillingPeriod: h.state.catalogue.billingPeriod,
      });
  return {
    id: "existing-operation", kind: kind as BillingOperationKind,
    shopId: h.principal.shopId, merchantPricingPlanId: kind === "CANCEL" ? null : planId,
    state: BillingOperationState.CONFIRMED, requestFingerprint: new Uint8Array(fingerprint),
    providerReference: kind === "SUBSCRIPTION_CREATE" ? null : reference,
  } as FixtureOperation;
}

async function expectError(promise: Promise<unknown>, code: string, statusCode = 409) {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof RecurringBillingCommandError && error.code === code && error.statusCode === statusCode,
  );
}

test("create intent locks shop then subscription, persists canonical quote and commits at ReadCommitted", async () => {
  const h = fixture();
  const intent = await h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "request-a", "paid-plan");
  assert.equal(intent.replay, false);
  assert.equal(intent.canonicalSiteUrl, h.principal.canonicalSiteUrl);
  assert.equal(intent.targetPlan?.displayName, "Growth");
  assert.deepEqual(h.events.slice(0, 5), [
    "transaction.start:ReadCommitted", "lock-1", "shop.read", "lock-2", "subscription.read",
  ]);
  assert.equal(h.state.resolverCount, 1);
  assert.equal(h.state.transactionCount, 1);
  assert.equal(h.state.activeTransaction, false);
  assert.equal(intent.operation.state, BillingOperationState.INITIATING);
  assert.equal(intent.operation.merchantPricingPlanId, "paid-plan");
  assert.equal(intent.operation.quotedAmountMinor, 4900);
  assert.equal(intent.operation.quotedCurrency, "USD");
  assert.equal(intent.operation.quotedBillingPeriod, "EVERY_30_DAYS");
  assert.deepEqual(Buffer.from(intent.operation.requestFingerprint), recurringRequestFingerprint({
    kind: "SUBSCRIPTION_CREATE", shopId: h.principal.shopId,
    merchantPricingPlanId: "paid-plan", quotedAmountMinor: 4900,
    quotedCurrency: "USD", quotedBillingPeriod: "EVERY_30_DAYS",
  }));
});

test("exact request replay preserves operation and skips resolver and new writes", async () => {
  const h = fixture();
  h.state.existing = replayRow(h, "SUBSCRIPTION_CREATE");
  const intent = await h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "request-a", "paid-plan");
  assert.equal(intent.replay, true);
  assert.equal(intent.operation.id, "existing-operation");
  assert.equal(intent.targetPlan, null);
  assert.equal(h.state.resolverCount, 0);
  assert.equal(h.state.created.length, 0);
  assert.equal(h.events.includes("operations.read"), false);
  assert.equal(h.events.includes("plan.resolve"), false);
});

test("replay refuses different kind, target, missing reference and mutable quote", async () => {
  const h = fixture();
  h.state.existing = replayRow(h, "SUBSCRIPTION_CREATE");
  await expectError(h.persistence.persistIntent(h.principal, "PLAN_SWITCH", "same", "paid-plan"), "idempotency_conflict");
  await expectError(h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "same", "another-plan"), "idempotency_conflict");
  h.state.catalogue.recurringAmountMinor = 4901;
  await expectError(h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "same", "paid-plan"), "idempotency_conflict");
  h.state.existing = replayRow(h, "CANCEL");
  h.state.existing.providerReference = null;
  await expectError(h.persistence.persistIntent(h.principal, "CANCEL", "same"), "idempotency_conflict");
  assert.equal(h.state.created.length, 0);
});

test("invalid shop identity, platform and onboarding fail closed before subscription access", async () => {
  const h = fixture();
  h.state.shop.domain = "https://other-tenant.test";
  await expectError(h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "key", "paid-plan"), "billing_shop_invalid");
  assert.equal(h.events.includes("subscription.read"), false);
  h.state.shop.domain = h.principal.canonicalSiteUrl;
  h.state.shop.platform = "SHOPIFY";
  await expectError(h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "key", "paid-plan"), "billing_shop_invalid");
  h.state.shop.platform = "WOOCOMMERCE";
  h.state.shop.onboardingCompleted = false;
  await expectError(h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "key", "paid-plan"), "billing_not_initialized");
  assert.equal(h.state.created.length, 0);
});

test("unresolved operations and confirmed cancellation block duplicate create until a Free reset", async () => {
  const h = fixture();
  h.state.operations = [{ kind: BillingOperationKind.SUBSCRIPTION_CREATE, state: BillingOperationState.OUTCOME_UNKNOWN, providerReference: null }];
  await expectError(h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "key", "paid-plan"), "billing_operation_conflict");
  h.state.operations = [{ kind: BillingOperationKind.CANCEL, state: BillingOperationState.CONFIRMED, providerReference: "former-contract" }];
  asPaid(h, "former-contract");
  await expectError(h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "key", "paid-plan"), "billing_operation_conflict");
  h.state.subscription.planId = "free-plan";
  h.state.subscription.plan = { id: "free-plan", kind: BillingPlanKind.FREE, shopifyPlanHandle: "free-handle", active: true };
  h.state.subscription.providerSubscriptionId = null;
  const intent = await h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "retry-key", "paid-plan");
  assert.equal(intent.replay, false);
  assert.equal(h.state.created.length, 1);
});

test("plan-switch protects existing contract eligibility and current catalogue mapping", async () => {
  const h = fixture();
  asPaid(h);
  h.state.currentCatalogueId = "paid-plan";
  await expectError(h.persistence.persistIntent(h.principal, "PLAN_SWITCH", "key", "paid-plan"), "billing_plan_unchanged");
  h.state.currentCatalogueId = "old-paid-plan";
  h.state.subscription.cancelAtPeriodEnd = true;
  await expectError(h.persistence.persistIntent(h.principal, "PLAN_SWITCH", "key", "paid-plan"), "subscription_switch_not_allowed");
  h.state.subscription.cancelAtPeriodEnd = false;
  const intent = await h.persistence.persistIntent(h.principal, "PLAN_SWITCH", "key", "paid-plan");
  assert.equal(intent.operation.providerReference, "woo-contract");
  assert.equal(intent.operation.kind, BillingOperationKind.PLAN_SWITCH);
});

test("cancellation allows provider-backed FROZEN contracts and persists no plan quote", async () => {
  const h = fixture();
  asPaid(h);
  h.state.subscription.status = SubscriptionProjectionStatus.FROZEN;
  const intent = await h.persistence.persistIntent(h.principal, "CANCEL", "cancel-key");
  assert.equal(intent.operation.kind, BillingOperationKind.CANCEL);
  assert.equal(intent.operation.providerReference, "woo-contract");
  assert.equal(intent.operation.merchantPricingPlanId, null);
  assert.equal(intent.operation.quotedAmountMinor, null);
  assert.equal(h.state.resolverCount, 0);
  const free = fixture();
  await expectError(free.persistence.persistIntent(free.principal, "CANCEL", "cancel-key"), "no_recurring_subscription");
});

test("materialisation retry happens only once, and invalid configuration retains failure mapping", async () => {
  const h = fixture();
  h.state.resolverErrors.push(new RetryFreeActivationTransactionError());
  const intent = await h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "key", "paid-plan");
  assert.equal(intent.replay, false);
  assert.equal(h.state.transactionCount, 2);
  assert.equal(h.state.resolverCount, 2);

  const retryFailure = fixture();
  retryFailure.state.resolverErrors.push(new RetryFreeActivationTransactionError(), new RetryFreeActivationTransactionError());
  await expectError(retryFailure.persistence.persistIntent(retryFailure.principal, "SUBSCRIPTION_CREATE", "key", "paid-plan"), "billing_plan_materialization_conflict");
  assert.equal(retryFailure.state.transactionCount, 2);

  const unavailable = fixture();
  unavailable.state.resolverErrors.push(new FreePlanConfigurationUnavailableError());
  await expectError(unavailable.persistence.persistIntent(unavailable.principal, "SUBSCRIPTION_CREATE", "key", "paid-plan"), "billing_plan_materialization_invalid");
});

test("P2002 operation uniqueness collision maps to the existing billing conflict", async () => {
  const h = fixture();
  h.state.forceDbError = new Prisma.PrismaClientKnownRequestError("unique constraint", {
    code: "P2002", clientVersion: "6.19.3",
  });
  await expectError(h.persistence.persistIntent(h.principal, "SUBSCRIPTION_CREATE", "key", "paid-plan"), "billing_operation_conflict");
});

test("provider executes only after committed intent and does not execute for replay", async () => {
  const h = fixture();
  const providerCalls: string[] = [];
  const provider = {
    createSubscription: async () => {
      assert.equal(h.state.activeTransaction, false, "provider call must follow durable transaction commit");
      providerCalls.push("create");
      return { id: "external-contract", confirmation_url: "https://sandbox.woocommerce.com/confirm" };
    },
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => { throw new Error("unexpected cancellation"); },
  } as unknown as ConstructorParameters<typeof RecurringSubscriptionCommandService>[1];
  const service = new RecurringSubscriptionCommandService(h.database, provider, "sandbox", h.resolver);
  const created = await service.create(h.principal, "key", "paid-plan");
  assert.equal(created.state, BillingOperationState.AWAITING_CONFIRMATION);
  assert.deepEqual(providerCalls, ["create"]);
  // The recorded outcome is the replay result. The same key must not call Woo again.
  h.state.existing = h.state.created[0] ?? null;
  const replayed = await service.create(h.principal, "key", "paid-plan");
  assert.deepEqual(replayed, created);
  assert.deepEqual(providerCalls, ["create"]);
  assert.equal(h.state.created.length, 1);
});
