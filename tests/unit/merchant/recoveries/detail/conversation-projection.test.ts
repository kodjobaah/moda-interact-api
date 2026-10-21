import assert from "node:assert/strict";
import test from "node:test";
import { humanMessagingProjection, recoveryConversationDetail } from "../../../../../src/merchant/recoveries/detail/conversation-projection.js";

const now = new Date("2026-10-21T12:00:00.000Z");
const initial = { sequence: 1, sentAt: new Date("2026-10-19T00:00:00.000Z"),
  status: "WAITING_FOR_RESPONSE", initiatedBy: "AUTOMATION" as const, initiationKey: null,
  outboundMessageId: "initial-msg" };
const conversation = { id: "c", controlMode: "HUMAN" as const, controlRevision: 4 };
test("projection uses only the verified inbound query and preserves exact service window", async () => {
  let where: unknown;
  const tx = { conversationMessage: { findFirst: async (args: {where: unknown}) => {
    where = args.where;
    return { createdAt: new Date("2026-10-20T12:00:00.000Z") };
  } } } as never;
  const value = await recoveryConversationDetail(tx, conversation, [initial], now);
  assert.equal(value?.lastInboundAt, "2026-10-20T12:00:00.000Z");
  assert.equal(value?.windowExpiresAt, now.toISOString());
  assert.equal(value?.controlRevision, 4);
  assert.deepEqual(value?.followUp, { sequence2Used: false, initiatedBy: null });
  assert.deepEqual(where, { conversationId: "c", direction: "INBOUND", senderType: "CUSTOMER",
    providerMessageId: { not: null }, createdAt: { gte: initial.sentAt, lte: now } });
});
test("missing initial or conversation cannot invent inbound evidence; claimed attempt is used", async () => {
  const tx = { conversationMessage: { findFirst: async () => { throw Error("unexpected inbound read"); } } } as never;
  assert.equal(await recoveryConversationDetail(tx, null, [], now), null);
  const result = await recoveryConversationDetail(tx, conversation,
    [{ sequence: 2, sentAt: null, initiatedBy: "HUMAN", initiationKey: "cmd", status: "PENDING", outboundMessageId: null }], now);
  assert.equal(result?.lastInboundAt, null);
  assert.deepEqual(result?.followUp, { sequence2Used: true, initiatedBy: "HUMAN" });
});
test("merchant restriction is presentation only, defaults active and never exposes admin reason", () => {
  assert.deepEqual(humanMessagingProjection(null), { humanMessagingAllowed: true, humanMessagingStatus: "ACTIVE" });
  assert.deepEqual(humanMessagingProjection("SUSPENDED"), { humanMessagingAllowed: false, humanMessagingStatus: "SUSPENDED" });
  assert.deepEqual(humanMessagingProjection("UNEXPECTED"), { humanMessagingAllowed: false, humanMessagingStatus: "SUSPENDED" });
});
