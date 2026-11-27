import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { WooConfirmedSentOfferResolver, restoreOfferAttemptSelect } from "../../../../src/woocommerce/recovery-restore/offer-resolver.js";

const input = {
  shopId: "shop-1",
  recoveryId: "recovery-1",
  generation: 4,
  conversationId: "conversation-1",
};
const checkoutReceipt = JSON.stringify({
  contract: "moda.whatsapp.automated-template-parameters.v1",
  recoveryPromise: { kind: "CODE_OFFER", promotionTarget: "CHECKOUT", providerDiscountId: "discount-1", code: "SAVE15" },
});

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1", checkoutRecoveryId: input.recoveryId,
    trigger: "INITIAL", recipient: "447700900001", status: "WAITING_FOR_RESPONSE",
    initiatedBy: null, initiationKey: null, claimedAt: null, followUpDueAt: null, customerRespondedAt: null,
    deliveryRetryIntent: null,
    sequence: 1,
    sentAt: new Date("2026-10-30T12:00:00.000Z"),
    outboundMessageId: "message-1",
    checkoutRecovery: {
      shopId: input.shopId,
      generation: input.generation,
      conversation: { id: input.conversationId, type: "RECOVERY", shopId: null },
    },
    outboundMessage: {
      id: "message-1",
      conversationId: input.conversationId,
      direction: "OUTBOUND",
      senderType: "AUTOMATION",
      status: "SENT",
      providerMessageId: "provider-message-1",
      content: checkoutReceipt,
      sentAt: new Date("2026-10-30T12:00:00.000Z"), deliveredAt: null, readAt: null, failedAt: null,
      providerDispatchKey: null, providerDispatchAdmittedAt: null, providerDispatchControlRevision: null,
      dispatchProviderAccountId: "1234", dispatchProviderPhoneNumberId: "5678",
    },
    ...overrides,
  };
}

function resolver(value: unknown, queries: unknown[] = [], warnings: unknown[] = []) {
  return new WooConfirmedSentOfferResolver({
    recoveryOutreachAttempt: {
      async findMany(query: unknown) {
        queries.push(query);
        return value === null ? [] : Array.isArray(value) ? value : [value];
      },
    },
  } as never, { warn(event: string, fields: unknown) { warnings.push([event, fields]); } } as never);
}

test("reads bounded tenant and generation-scoped history and returns the legacy confirmed code", async () => {
  const queries: unknown[] = [];
  const result = await resolver(attempt(), queries).read(input);
  assert.deepEqual(result, { kind: "CHECKOUT_CODE", code: "SAVE15", providerDiscountId: "discount-1" });
  assert.deepEqual(queries[0], {
    where: { checkoutRecoveryId: input.recoveryId, checkoutRecovery: { shopId: input.shopId, generation: input.generation } },
    orderBy: { sequence: "asc" }, take: 101, select: restoreOfferAttemptSelect,
  });
  assert.equal(restoreOfferAttemptSelect.deliveryRetryIntent.select.failedMessageId, true);
  assert.equal(restoreOfferAttemptSelect.outboundMessage.select.providerDispatchKey, true);
  assert.equal(restoreOfferAttemptSelect.outboundMessage.select.content, true);
});

test("absent, failed, and unconfirmed attempts produce no confirmed offer", async () => {
  assert.deepEqual(await resolver(null).read(input), { kind: "NONE", reason: "NO_CONFIRMED_OFFER" });
  assert.deepEqual(await resolver(attempt({ sentAt: null, outboundMessageId: null })).read(input),
    { kind: "NONE", reason: "NO_CONFIRMED_OFFER" });
});

test("mismatched tenant, generation, conversation, or provider confirmation is unverifiable and warned", async () => {
  for (const evidence of [
    attempt({ checkoutRecovery: { shopId: "other-shop", generation: input.generation, conversation: { id: input.conversationId, type: "RECOVERY", shopId: null } } }),
    attempt({ checkoutRecovery: { shopId: input.shopId, generation: input.generation - 1, conversation: { id: input.conversationId, type: "RECOVERY", shopId: null } } }),
    attempt({ outboundMessage: { ...attempt().outboundMessage, conversationId: "other-conversation" } }),
    attempt({ outboundMessage: { ...attempt().outboundMessage, direction: "INBOUND" } }),
    attempt({ outboundMessage: { ...attempt().outboundMessage, providerMessageId: null } }),
  ]) {
    const warnings: unknown[] = [];
    const result = await resolver(evidence, [], warnings).read(input);
    assert.deepEqual(result, { kind: "NONE", reason: "UNVERIFIABLE" });
    assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(warnings).includes("SAVE15"), false);
  }
});

test("database read failures propagate instead of becoming NONE", async () => {
  const databaseError = new Error("database unavailable");
  const reader = new WooConfirmedSentOfferResolver({
    recoveryOutreachAttempt: { async findMany() { throw databaseError; } },
  } as never, { warn() {} } as never);
  await assert.rejects(reader.read(input), error => error === databaseError);
});

function retryHistory() {
  const old = attempt();
  const sentAt = new Date("2026-10-30T13:00:00.000Z");
  const retryId = "retry_intent-3";
  const retryReceipt = checkoutReceipt.replace("SAVE15", "RETRY25");
  const failed = { ...old, status: "FAILED", outboundMessage: { ...old.outboundMessage, status: "FAILED", failedAt: sentAt },
    deliveryRetryIntent: { id: "intent-3", failedAttemptId: old.id, failedMessageId: old.outboundMessageId, cancelledAt: null } };
  const retry = { ...old, id: retryId, sequence: 3, sentAt, outboundMessageId: "retry-message",
    outboundMessage: { ...old.outboundMessage, id: "retry-message", providerMessageId: "wamid-retry", content: retryReceipt,
      status: "DELIVERED", sentAt, deliveredAt: sentAt,
      providerDispatchKey: `arch046-woo-initial-${createHash("sha256").update(input.shopId).update("\0").update(retryId).digest("hex")}`,
      providerDispatchAdmittedAt: sentAt, providerDispatchControlRevision: 0 } };
  return { failed, retry };
}

test("returns only the confirmed successor's offer rather than the failed original offer", async () => {
  const { failed, retry } = retryHistory();
  assert.deepEqual(await resolver([retry, failed]).read(input),
    { kind: "CHECKOUT_CODE", code: "RETRY25", providerDiscountId: "discount-1" });
  assert.deepEqual(await resolver([failed, { ...retry, outboundMessage: { ...retry.outboundMessage, status: "READ", readAt: retry.sentAt } }]).read(input),
    { kind: "CHECKOUT_CODE", code: "RETRY25", providerDiscountId: "discount-1" });
});

test("never restores an offer from a pending, accepted-only, unverified or conflicting retry", async () => {
  const { failed, retry } = retryHistory();
  for (const rows of [
    [failed],
    [failed, { ...retry, status: "PENDING", sentAt: null, outboundMessageId: null, outboundMessage: null }],
    [failed, { ...retry, outboundMessage: { ...retry.outboundMessage, status: "SENT", deliveredAt: null } }],
    [failed, { ...retry, outboundMessage: { ...retry.outboundMessage, providerDispatchKey: "incorrect" } }],
    [failed, { ...retry, outboundMessage: { ...retry.outboundMessage, dispatchProviderPhoneNumberId: "9999" } }],
    [failed, { ...retry, outboundMessage: { ...retry.outboundMessage, conversationId: "foreign" } }],
    [retry],
    [{ ...failed, deliveryRetryIntent: { ...failed.deliveryRetryIntent, cancelledAt: retry.sentAt } }, retry],
    [{ ...failed, outboundMessage: { ...failed.outboundMessage, status: "READ", readAt: retry.sentAt } }, retry],
    Array.from({ length: 101 }, () => retry),
  ]) {
    const offer = await resolver(rows).read(input);
    assert.equal(offer.kind, "NONE");
  }
});
