import assert from "node:assert/strict";
import test from "node:test";
import { WooConfirmedSentOfferResolver } from "../../../../src/woocommerce/recovery-restore/offer-resolver.js";

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
    checkoutRecoveryId: input.recoveryId,
    sequence: 1,
    sentAt: new Date("2026-10-30T12:00:00.000Z"),
    outboundMessageId: "message-1",
    checkoutRecovery: {
      shopId: input.shopId,
      generation: input.generation,
      conversation: { id: input.conversationId },
    },
    outboundMessage: {
      id: "message-1",
      conversationId: input.conversationId,
      direction: "OUTBOUND",
      senderType: "AUTOMATION",
      status: "SENT",
      providerMessageId: "provider-message-1",
      content: checkoutReceipt,
    },
    ...overrides,
  };
}

function resolver(value: unknown, queries: unknown[] = [], warnings: unknown[] = []) {
  return new WooConfirmedSentOfferResolver({
    recoveryOutreachAttempt: {
      async findUnique(query: unknown) {
        queries.push(query);
        return value;
      },
    },
  } as never, { warn(event: string, fields: unknown) { warnings.push([event, fields]); } } as never);
}

test("reads only the authorized recovery's sequence-one relation and returns its confirmed code", async () => {
  const queries: unknown[] = [];
  const result = await resolver(attempt(), queries).read(input);
  assert.deepEqual(result, { kind: "CHECKOUT_CODE", code: "SAVE15", providerDiscountId: "discount-1" });
  assert.deepEqual(queries[0], {
    where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: input.recoveryId, sequence: 1 } },
    select: {
      checkoutRecoveryId: true,
      sequence: true,
      sentAt: true,
      outboundMessageId: true,
      checkoutRecovery: { select: { shopId: true, generation: true, conversation: { select: { id: true } } } },
      outboundMessage: { select: {
        id: true, conversationId: true, direction: true, senderType: true, status: true,
        providerMessageId: true, content: true,
      } },
    },
  });
});

test("absent, failed, and unconfirmed attempts produce no confirmed offer", async () => {
  assert.deepEqual(await resolver(null).read(input), { kind: "NONE", reason: "NO_CONFIRMED_OFFER" });
  assert.deepEqual(await resolver(attempt({ sentAt: null, outboundMessageId: null })).read(input),
    { kind: "NONE", reason: "NO_CONFIRMED_OFFER" });
});

test("mismatched tenant, generation, conversation, or provider confirmation is unverifiable and warned", async () => {
  for (const evidence of [
    attempt({ checkoutRecovery: { shopId: "other-shop", generation: input.generation, conversation: { id: input.conversationId } } }),
    attempt({ checkoutRecovery: { shopId: input.shopId, generation: input.generation - 1, conversation: { id: input.conversationId } } }),
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
    recoveryOutreachAttempt: { async findUnique() { throw databaseError; } },
  } as never, { warn() {} } as never);
  await assert.rejects(reader.read(input), error => error === databaseError);
});