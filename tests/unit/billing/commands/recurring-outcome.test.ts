import assert from "node:assert/strict";
import test from "node:test";
import { BillingOperationKind, BillingOperationState, type BillingOperation } from "@prisma/client";
import { WooBillingProviderError } from "../../../../src/woocommerce/billing/woo-billing-client.js";
import { RecurringBillingCommandError } from "../../../../src/billing/commands/recurring-command-error.js";
import { RecurringOutcomePersistence } from "../../../../src/billing/commands/recurring-outcome.js";

type OperationMutation = {
  where: { id: string; state: BillingOperationState; providerReference?: null };
  data: {
    state: BillingOperationState;
    providerReference?: string;
    confirmationUrl?: string;
    lastErrorCode: string | null;
  };
};

function operation(
  kind: BillingOperationKind = BillingOperationKind.SUBSCRIPTION_CREATE,
  state: BillingOperationState = BillingOperationState.INITIATING,
): BillingOperation {
  return {
    id: "operation-1",
    shopId: "shop-1",
    kind,
    state,
    providerReference: kind === BillingOperationKind.SUBSCRIPTION_CREATE ? null : "woo-existing",
    confirmationUrl: state === BillingOperationState.INITIATING ? null : "https://woocommerce.com/checkout/existing",
    lastErrorCode: null,
  } as BillingOperation;
}

function fixture(
  kind: BillingOperationKind = BillingOperationKind.SUBSCRIPTION_CREATE,
  initialState: BillingOperationState = BillingOperationState.INITIATING,
) {
  let current = operation(kind, initialState);
  let collisionShop: string | null = null;
  let beforeUpdate: (() => void) | undefined;
  const events: string[] = [];
  const updates: OperationMutation[] = [];
  const transaction = {
    $queryRaw: async () => { events.push("lock-provider-reference"); return []; },
    billingOperation: {
      findFirst: async (args: { where: { providerReference: string; shopId: { not: string } } }) => {
        events.push("collision-lookup");
        return collisionShop && args.where.shopId.not !== collisionShop ? { id: "other-operation" } : null;
      },
      updateMany: async (args: OperationMutation) => {
        events.push("update-CAS");
        updates.push(args);
        beforeUpdate?.();
        beforeUpdate = undefined;
        if (args.where.id !== current.id || args.where.state !== current.state ||
          ("providerReference" in args.where && current.providerReference !== args.where.providerReference)) {
          return { count: 0 };
        }
        current = { ...current, ...args.data };
        return { count: 1 };
      },
      findUnique: async (args: { where: { id: string } }) => {
        events.push("read-current");
        return args.where.id === current.id ? current : null;
      },
    },
  };
  const db = {
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => {
      events.push("transaction-begin");
      const result = await callback(transaction);
      events.push("transaction-commit");
      return result;
    },
  } as unknown as ConstructorParameters<typeof RecurringOutcomePersistence>[0];
  return {
    outcomes: new RecurringOutcomePersistence(db, "production"),
    events, updates,
    setCollision(shop: string) { collisionShop = shop; },
    setBeforeUpdate(callback: () => void) { beforeUpdate = callback; },
    current() { return current; },
    change(next: Partial<BillingOperation>) { current = { ...current, ...next }; },
  };
}

const validEvidence = { id: "woo-confirmed", confirmation_url: "https://woocommerce.com/checkout/new" };
const evidence = { id: "woo-confirmed", confirmationUrl: "https://woocommerce.com/checkout/new" };

function assertCommandError(error: unknown, statusCode: number, code: string, safeCode?: string): boolean {
  assert.ok(error instanceof RecurringBillingCommandError);
  assert.equal(error.statusCode, statusCode);
  assert.equal(error.code, code);
  assert.equal(error.operationId, "operation-1");
  if (safeCode !== undefined) assert.equal(error.safeProviderCode, safeCode);
  return true;
}

test("validates provider evidence and preserves the configured redirect-host contract", () => {
  const h = fixture();
  assert.deepEqual(h.outcomes.validateSubscriptionEvidence(validEvidence, "SUBSCRIPTION_CREATE", null), evidence);
  for (const invalid of [null, [], { id: " ", confirmation_url: validEvidence.confirmation_url },
    { id: "bad\nref", confirmation_url: validEvidence.confirmation_url },
    { id: "contract", confirmation_url: "http://woocommerce.com/checkout" },
    { id: "contract", confirmation_url: "https://attacker.invalid/checkout" },
    { id: "contract", confirmation_url: "https://user@woocommerce.com/checkout" }]) {
    assert.throws(() => h.outcomes.validateSubscriptionEvidence(invalid, "SUBSCRIPTION_CREATE", null), WooBillingProviderError);
  }
  assert.throws(() => h.outcomes.validateSubscriptionEvidence(
    { id: "woo-existing", confirmation_url: "https://sandbox.woocommerce.com/checkout/new" },
    "PLAN_SWITCH", "woo-existing",
  ), (error: unknown) => error instanceof WooBillingProviderError && error.safeCode === "PROVIDER_REDIRECT_INVALID");
});

test("rejects switch provider reference mismatches before outcome persistence", () => {
  const h = fixture(BillingOperationKind.PLAN_SWITCH);
  assert.throws(() => h.outcomes.validateSubscriptionEvidence(validEvidence, "PLAN_SWITCH", "woo-existing"),
    (error: unknown) => error instanceof WooBillingProviderError && error.outcome === "OUTCOME_UNKNOWN" &&
      error.safeCode === "PROVIDER_CONTRACT_MISMATCH");
  assert.equal(h.events.length, 0);
});

test("create confirmation locks provider reference before collision lookup and guarded update", async () => {
  const h = fixture();
  const response = await h.outcomes.confirmSubscription(h.current(), evidence);
  assert.deepEqual(response, {
    schemaVersion: 1, operationId: "operation-1", kind: "SUBSCRIPTION_CREATE",
    state: "AWAITING_CONFIRMATION", confirmationUrl: evidence.confirmationUrl,
  });
  assert.deepEqual(h.events, [
    "transaction-begin", "lock-provider-reference", "collision-lookup", "update-CAS", "read-current", "transaction-commit",
  ]);
  assert.deepEqual(h.updates[0]?.where, {
    id: "operation-1", state: BillingOperationState.INITIATING, providerReference: null,
  });
  assert.equal(h.current().providerReference, evidence.id);
});

test("colliding reference is not attached to a second merchant and records unknown outcome", async () => {
  const h = fixture();
  h.setCollision("shop-2");
  await assert.rejects(h.outcomes.confirmSubscription(h.current(), evidence),
    (error: unknown) => assertCommandError(error, 502, "billing_provider_outcome_unknown", "PROVIDER_CONTRACT_COLLISION"));
  assert.equal(h.current().state, BillingOperationState.OUTCOME_UNKNOWN);
  assert.equal(h.current().providerReference, null);
  assert.equal(h.current().confirmationUrl, null);
  assert.deepEqual(h.updates[0]?.data, {
    state: BillingOperationState.OUTCOME_UNKNOWN, lastErrorCode: "PROVIDER_CONTRACT_COLLISION",
  });
});

test("provider confirmation arriving after later confirmation returns persisted newer result", async () => {
  const h = fixture();
  h.setBeforeUpdate(() => h.change({
    state: BillingOperationState.CONFIRMED,
    confirmationUrl: "https://woocommerce.com/checkout/newer",
    providerReference: "woo-newer",
  }));
  const result = await h.outcomes.confirmSubscription(h.current(), evidence);
  assert.equal(result.state, "CONFIRMED");
  assert.equal(result.confirmationUrl, "https://woocommerce.com/checkout/newer");
  assert.equal(h.current().providerReference, "woo-newer");
});

test("late provider rejection does not replace a confirmed operation", async () => {
  const h = fixture();
  h.setBeforeUpdate(() => h.change({
    state: BillingOperationState.CONFIRMED,
    confirmationUrl: "https://woocommerce.com/checkout/confirmed",
  }));
  await assert.rejects(h.outcomes.failProviderOperation("operation-1", new WooBillingProviderError("DEFINITE_REJECTION", "PROVIDER_REJECTED")),
    (error: unknown) => assertCommandError(error, 502, "billing_provider_outcome_unknown"));
  assert.equal(h.current().state, BillingOperationState.CONFIRMED);
  assert.equal(h.current().lastErrorCode, null);
});

test("definitive provider rejection updates FAILED and reports 422 with bounded code", async () => {
  const h = fixture();
  await assert.rejects(h.outcomes.failProviderOperation("operation-1", new WooBillingProviderError("DEFINITE_REJECTION", "PROVIDER_REJECTED")),
    (error: unknown) => assertCommandError(error, 422, "billing_provider_rejected", "PROVIDER_REJECTED"));
  assert.equal(h.current().state, BillingOperationState.FAILED);
  assert.equal(h.current().lastErrorCode, "PROVIDER_REJECTED");
});

test("ambiguous transport outcome persists OUTCOME_UNKNOWN without fabricating success", async () => {
  const h = fixture();
  await assert.rejects(h.outcomes.failProviderOperation("operation-1", new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_TRANSPORT_ERROR")),
    (error: unknown) => assertCommandError(error, 502, "billing_provider_outcome_unknown", "PROVIDER_TRANSPORT_ERROR"));
  assert.equal(h.current().state, BillingOperationState.OUTCOME_UNKNOWN);
  assert.equal(h.current().lastErrorCode, "PROVIDER_TRANSPORT_ERROR");
});

test("unrecognised provider errors do not expose raw exception text", async () => {
  const h = fixture();
  await assert.rejects(h.outcomes.failProviderOperation("operation-1", new Error("private access secret")),
    (error: unknown) => assertCommandError(error, 502, "billing_provider_outcome_unknown", "PROVIDER_RESPONSE_INVALID"));
  assert.equal(h.current().lastErrorCode, "PROVIDER_RESPONSE_INVALID");
});

test("switch confirmation remains scoped to the original provider reference", async () => {
  const h = fixture(BillingOperationKind.PLAN_SWITCH);
  const response = await h.outcomes.confirmSubscription(h.current(), {
    id: "woo-existing", confirmationUrl: "https://woocommerce.com/checkout/switched",
  });
  assert.equal(response.kind, "PLAN_SWITCH");
  assert.equal(response.state, "AWAITING_CONFIRMATION");
  assert.equal(h.current().providerReference, "woo-existing");
  assert.equal(h.updates[0]?.where.providerReference, undefined);
  const next = fixture(BillingOperationKind.PLAN_SWITCH);
  await assert.rejects(next.outcomes.confirmSubscription(next.current(), evidence),
    (error: unknown) => assertCommandError(error, 409, "billing_provider_outcome_unknown", "PROVIDER_CONTRACT_MISMATCH"));
  assert.equal(next.current().state, BillingOperationState.OUTCOME_UNKNOWN);
});

test("cancel confirmation uses INITIATING CAS and returns null confirmation URL", async () => {
  const h = fixture(BillingOperationKind.CANCEL);
  const response = await h.outcomes.confirmCancellation("operation-1");
  assert.equal(response.kind, "CANCEL");
  assert.equal(response.state, "CONFIRMED");
  assert.equal(response.confirmationUrl, null);
  assert.deepEqual(h.updates[0]?.where, { id: "operation-1", state: BillingOperationState.INITIATING });
  assert.equal(h.current().providerReference, "woo-existing");
});

test("late cancellation confirmation reads the newer persisted operation result", async () => {
  const h = fixture(BillingOperationKind.CANCEL);
  h.setBeforeUpdate(() => h.change({ state: BillingOperationState.CONFIRMED }));
  const result = await h.outcomes.confirmCancellation("operation-1");
  assert.equal(result.state, "CONFIRMED");
  assert.equal(h.updates.length, 1);
});

test("concurrent compare-and-set loss returns current failure without overwriting it", async () => {
  const h = fixture(BillingOperationKind.CANCEL);
  h.setBeforeUpdate(() => h.change({ state: BillingOperationState.OUTCOME_UNKNOWN, lastErrorCode: "PRIOR_PROVIDER_ERROR" }));
  await assert.rejects(h.outcomes.confirmCancellation("operation-1"),
    (error: unknown) => assertCommandError(error, 409, "billing_provider_outcome_unknown", "PRIOR_PROVIDER_ERROR"));
  assert.equal(h.current().lastErrorCode, "PRIOR_PROVIDER_ERROR");
});

test("replay of terminal states never enters an outcome transaction", () => {
  for (const kind of [BillingOperationKind.CANCEL, BillingOperationKind.SUBSCRIPTION_CREATE]) {
    const h = fixture(kind, BillingOperationState.CONFIRMED);
    const result = h.outcomes.replayOperation(h.current());
    assert.equal(result.state, "CONFIRMED");
    assert.equal(h.events.length, 0);
  }
  const h = fixture(BillingOperationKind.CANCEL, BillingOperationState.FAILED);
  assert.throws(() => h.outcomes.replayOperation(h.current()),
    (error: unknown) => assertCommandError(error, 409, "billing_operation_failed"));
  assert.equal(h.events.length, 0);
});
