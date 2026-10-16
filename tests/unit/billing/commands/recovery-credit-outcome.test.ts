import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BillingOperationState, Prisma, type BillingOperation } from "@prisma/client";
import { RecoveryCreditPurchaseCommandError } from "../../../../src/billing/commands/recovery-credit-command-error.js";
import {
  RecoveryCreditOutcomePersistence,
  operationResponse,
  replayOperation,
} from "../../../../src/billing/commands/recovery-credit-outcome.js";
import { WooBillingProviderError } from "../../../../src/woocommerce/billing/woo-billing-client.js";

type OutcomeDatabase = ConstructorParameters<typeof RecoveryCreditOutcomePersistence>[0];

function fixture(state: BillingOperationState = BillingOperationState.INITIATING) {
  const original = {
    id: "operation-1",
    shopId: "shop-a",
    state,
    providerReference: null,
    confirmationUrl: null,
    recoveryCreditPurchaseId: "purchase-1",
    lastErrorCode: null,
  } as BillingOperation;
  const rows = [original];
  const events: string[] = [];
  let inTransaction = false;
  const transaction = {
    $queryRaw: async (sql: Prisma.Sql) => {
      assert.equal(inTransaction, true);
      assert.match(sql.strings.join(""), /pg_advisory_xact_lock\(hashtextextended/);
      events.push("lock.reference");
      return [{ "?column?": 1 }];
    },
    billingOperation: {
      findFirst: async (query: { where: { providerReference: string; shopId: { not: string } } }) => {
        events.push("read.collision");
        return rows.find((row) => row.providerReference === query.where.providerReference && row.shopId !== query.where.shopId.not) ?? null;
      },
      updateMany: async (query: {
        where: { id: string; state: BillingOperationState; providerReference?: null; confirmationUrl?: null };
        data: Partial<BillingOperation>;
      }) => {
        events.push("update.operation");
        const row = rows.find((candidate) => candidate.id === query.where.id);
        if (!row || row.state !== query.where.state ||
          ("providerReference" in query.where && row.providerReference !== query.where.providerReference) ||
          ("confirmationUrl" in query.where && row.confirmationUrl !== query.where.confirmationUrl)) return { count: 0 };
        Object.assign(row, query.data);
        return { count: 1 };
      },
      findUnique: async (query: { where: { id: string } }) => {
        events.push("read.current");
        return rows.find((row) => row.id === query.where.id) ?? null;
      },
    },
  };
  const database = {
    $transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>): Promise<T> => {
      events.push("transaction.begin");
      inTransaction = true;
      try { return await callback(transaction); }
      finally { inTransaction = false; events.push("transaction.end"); }
    },
  } as unknown as OutcomeDatabase;
  const outcome = new RecoveryCreditOutcomePersistence(database, "production");
  return { operation: original, rows, events, outcome, inTransaction: () => inTransaction };
}

async function expectError(promise: Promise<unknown>, status: number, code: string, safeCode?: string) {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof RecoveryCreditPurchaseCommandError &&
    error.statusCode === status && error.code === code &&
    error.operationId === "operation-1" && error.purchaseId === "purchase-1" &&
    error.safeProviderCode === safeCode,
  );
}

const chargeId = "9dfcdcea-5d85-4d26-af65-67a5216f8be0";
const confirmationUrl = "https://woocommerce.com/checkout/charge";

test("valid charge evidence is normalised and production/sandbox hosts remain separate", () => {
  const h = fixture();
  assert.deepEqual(h.outcome.validateChargeResponse({
    id: ` ${chargeId} `,
    confirmation_url: "https://woocommerce.com:443/checkout/charge",
  }), { id: chargeId, confirmationUrl });
  const sandbox = new RecoveryCreditOutcomePersistence({} as OutcomeDatabase, "sandbox");
  assert.deepEqual(sandbox.validateChargeResponse({
    id: chargeId,
    confirmation_url: "https://sandbox.woocommerce.com/checkout/charge",
  }), { id: chargeId, confirmationUrl: "https://sandbox.woocommerce.com/checkout/charge" });
});

test("malformed provider evidence is always an ambiguous outcome with a bounded code", () => {
  const h = fixture();
  for (const value of [
    null, [], "not an object", {},
    { id: "invalid", confirmation_url: confirmationUrl },
    { id: chargeId, confirmation_url: null },
    { id: chargeId, confirmation_url: "not-a-url" },
    { id: chargeId, confirmation_url: "a".repeat(2049) },
  ]) {
    assert.throws(() => h.outcome.validateChargeResponse(value), (error: unknown) =>
      error instanceof WooBillingProviderError && error.outcome === "OUTCOME_UNKNOWN" &&
      error.safeCode === "PROVIDER_RESPONSE_INVALID",
    );
  }
});

test("redirect verification rejects credentials, wrong hosts, schemes, ports and sandbox confusion", () => {
  const h = fixture();
  for (const confirmation_url of [
    "http://woocommerce.com/checkout",
    "https://woocommerce.com.evil.example/checkout",
    "https://evil.woocommerce.com/checkout",
    "https://sandbox.woocommerce.com/checkout",
    "https://user:password@woocommerce.com/checkout",
    "https://woocommerce.com:8443/checkout",
  ]) {
    assert.throws(() => h.outcome.validateChargeResponse({ id: chargeId, confirmation_url }), (error: unknown) =>
      error instanceof WooBillingProviderError && error.outcome === "OUTCOME_UNKNOWN" &&
      error.safeCode === "PROVIDER_REDIRECT_INVALID",
    );
  }
});

test("successful outcome obtains the provider-reference advisory lock before checking collision and updating", async () => {
  const h = fixture();
  const operation = await h.outcome.confirmProviderOperation(h.operation, { id: chargeId, confirmationUrl });
  assert.equal(operation, h.operation);
  assert.equal(operation.state, BillingOperationState.AWAITING_CONFIRMATION);
  assert.equal(operation.providerReference, chargeId);
  assert.equal(operation.confirmationUrl, confirmationUrl);
  assert.equal(operation.lastErrorCode, null);
  assert.deepEqual(h.events, [
    "transaction.begin", "lock.reference", "read.collision", "update.operation", "read.current", "transaction.end",
  ]);
  assert.equal(h.inTransaction(), false);
  assert.deepEqual(operationResponse(operation), {
    schemaVersion: 1, purchaseId: "purchase-1", operationId: "operation-1",
    state: "AWAITING_CONFIRMATION", confirmationUrl,
  });
});

test("cross-shop reference collision fails closed without storing the duplicate reference", async () => {
  const h = fixture();
  h.rows.push({ id: "other-operation", shopId: "shop-b", providerReference: chargeId } as BillingOperation);
  await expectError(h.outcome.confirmProviderOperation(h.operation, { id: chargeId, confirmationUrl }),
    502, "billing_provider_outcome_unknown", "PROVIDER_CONTRACT_COLLISION");
  assert.equal(h.operation.state, BillingOperationState.OUTCOME_UNKNOWN);
  assert.equal(h.operation.providerReference, null);
  assert.equal(h.operation.confirmationUrl, null);
  assert.deepEqual(h.events.slice(0, 4), [
    "transaction.begin", "lock.reference", "read.collision", "update.operation",
  ]);
});

test("same-shop provider reference does not trip the cross-shop collision guard", async () => {
  const h = fixture();
  h.rows.push({ id: "same-shop-operation", shopId: "shop-a", providerReference: chargeId } as BillingOperation);
  const result = await h.outcome.confirmProviderOperation(h.operation, { id: chargeId, confirmationUrl });
  assert.equal(result.state, BillingOperationState.AWAITING_CONFIRMATION);
});

test("stale confirmation cannot overwrite a newer confirmed operation or its original redirect", async () => {
  const h = fixture(BillingOperationState.CONFIRMED);
  h.operation.providerReference = randomUUID();
  h.operation.confirmationUrl = "https://woocommerce.com/checkout/confirmed";
  const result = await h.outcome.confirmProviderOperation(h.operation, { id: chargeId, confirmationUrl });
  assert.equal(result.state, BillingOperationState.CONFIRMED);
  assert.notEqual(result.providerReference, chargeId);
  assert.equal(result.confirmationUrl, "https://woocommerce.com/checkout/confirmed");
});

test("stale confirmation re-reads failed, unknown and initiating operations as 409 conflicts", async () => {
  for (const [state, code] of [
    [BillingOperationState.FAILED, "billing_operation_failed"],
    [BillingOperationState.OUTCOME_UNKNOWN, "billing_provider_outcome_unknown"],
  ] as const) {
    const h = fixture(state);
    await expectError(h.outcome.confirmProviderOperation(h.operation, { id: chargeId, confirmationUrl }), 409, code);
    assert.equal(h.operation.providerReference, null);
  }
  const h = fixture();
  h.operation.confirmationUrl = "https://woocommerce.com/checkout/stale";
  await expectError(h.outcome.confirmProviderOperation(h.operation, { id: chargeId, confirmationUrl }),
    409, "billing_operation_in_progress");
});

test("definitive Woo provider rejection persists FAILED, preserves REQUESTED credit and returns 422", async () => {
  const h = fixture();
  await expectError(h.outcome.failProviderOperation(h.operation, new WooBillingProviderError("DEFINITE_REJECTION", "PROVIDER_REJECTED")),
    422, "billing_provider_rejected", "PROVIDER_REJECTED");
  assert.equal(h.operation.state, BillingOperationState.FAILED);
  assert.equal(h.operation.lastErrorCode, "PROVIDER_REJECTED");
  assert.equal(h.operation.providerReference, null);
  assert.deepEqual(h.events, ["transaction.begin", "update.operation", "read.current", "transaction.end"]);
  await expectError(Promise.resolve().then(() => replayOperation(h.operation)),
    409, "billing_operation_failed", "PROVIDER_REJECTED");
});

test("unknown transport and unexpected errors persist OUTCOME_UNKNOWN without retrying", async () => {
  for (const [error, safeCode] of [
    [new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_TRANSPORT_ERROR"), "PROVIDER_TRANSPORT_ERROR"],
    [new Error("private provider error details"), "PROVIDER_RESPONSE_INVALID"],
  ] as const) {
    const h = fixture();
    await expectError(h.outcome.failProviderOperation(h.operation, error),
      502, "billing_provider_outcome_unknown", safeCode);
    assert.equal(h.operation.state, BillingOperationState.OUTCOME_UNKNOWN);
    await expectError(Promise.resolve().then(() => replayOperation(h.operation)),
      409, "billing_provider_outcome_unknown", safeCode);
  }
});

test("a late failure preserves committed AWAITING_CONFIRMATION and CONFIRMED outcomes", async () => {
  for (const state of [BillingOperationState.AWAITING_CONFIRMATION, BillingOperationState.CONFIRMED]) {
    const h = fixture(state);
    h.operation.confirmationUrl = confirmationUrl;
    h.operation.providerReference = chargeId;
    const outcome = await h.outcome.failProviderOperation(h.operation,
      new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_TRANSPORT_ERROR"));
    assert.equal(outcome.state, state);
    assert.equal(outcome.lastErrorCode, null);
    assert.equal(operationResponse(outcome).state, state);
  }
});

test("missing operation fails closed, and empty purchase evidence cannot form an accepted response", async () => {
  const h = fixture();
  h.rows.length = 0;
  await assert.rejects(h.outcome.confirmProviderOperation(h.operation, { id: chargeId, confirmationUrl }),
    (error: unknown) => error instanceof RecoveryCreditPurchaseCommandError &&
      error.statusCode === 500 && error.code === "internal_error");
  const invalid = { ...h.operation, state: BillingOperationState.AWAITING_CONFIRMATION, confirmationUrl };
  invalid.recoveryCreditPurchaseId = null;
  assert.throws(() => operationResponse(invalid), (error: unknown) =>
    error instanceof RecoveryCreditPurchaseCommandError && error.statusCode === 409);
});
