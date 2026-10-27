import assert from "node:assert/strict";
import test from "node:test";
import { parseHumanSendInput, humanPayloadDigest, SendHttpError, isSendStatusResponse } from "../../../../../src/merchant/conversations/messages/contract.js";
import { decodeNonDuplicateJson } from "../../../../../src/merchant/conversations/messages/request.js";
import { configuredFollowUpDue, windowOpen } from "../../../../../src/merchant/conversations/messages/eligibility.js";

const text = { kind: "HUMAN_TEXT", expectedControlRevision: 3,
  idempotencyKey: "client-001", textBody: "Hello, how can I help?" };
const followUp = { kind: "RECOVERY_FOLLOW_UP_TEMPLATE", expectedControlRevision: 3,
  idempotencyKey: "client-002", templateName: "approved_recovery_follow_up",
  templateLanguage: "en_GB", templateParameters: {} };

test("strict kind-exclusive input and versioned canonical payload", () => {
  assert.equal(parseHumanSendInput(text).kind, "HUMAN_TEXT");
  assert.equal(parseHumanSendInput(followUp).kind, "RECOVERY_FOLLOW_UP_TEMPLATE");
  const digest = humanPayloadDigest("convo", parseHumanSendInput(text));
  assert.match(digest, /^[a-f\d]{64}$/);
  assert.equal(digest, humanPayloadDigest("convo", parseHumanSendInput({ ...text, idempotencyKey: "another" })));
  assert.notEqual(digest, humanPayloadDigest("convo", parseHumanSendInput({ ...text, expectedControlRevision: 4 })));
  assert.notEqual(digest, humanPayloadDigest("different", parseHumanSendInput(text)));
  assert.notEqual(humanPayloadDigest("convo", parseHumanSendInput(followUp)),
    humanPayloadDigest("convo", parseHumanSendInput({ ...followUp, templateParameters: [] })));
});
test("invalid content, foreign fields, dynamic media and ambiguous JSON fail before database", () => {
  const malformed = [
    { ...text, shopId: "foreign" }, { ...text, moderationApproved: true },
    { ...text, textBody: "" }, { ...text, textBody: " whitespace " },
    { ...text, textBody: "a".repeat(4001) }, { ...text, textBody: "\u0001" },
    { ...text, expectedControlRevision: "1" }, { ...text, expectedControlRevision: -1 },
    { ...text, idempotencyKey: "x y" }, { ...text, templateName: "forged" },
    { ...followUp, textBody: "hello" }, { ...followUp, templateName: "Not Allowed!" },
    { ...followUp, templateParameters: { image: "https://example.invalid" } },
    { ...followUp, templateParameters: Array(17).fill("a") },
    { ...followUp, templateParameters: ["injected"] },
    { ...followUp, templateParameters: { body: "secret" } },
  ];
  for (const input of malformed) assert.throws(() => parseHumanSendInput(input), SendHttpError);
  for (const input of [
    '{"kind":"HUMAN_TEXT","kind":"RECOVERY_FOLLOW_UP_TEMPLATE"}',
    '{"kind":"HUMAN_TEXT","\\u006bind":"HUMAN_TEXT"}',
    '{"templateParameters":{"x":"a","x":"b"}}',
    '{"a":[1,2,]}', '{"a":{},"a":{}}',
  ]) assert.throws(() => decodeNonDuplicateJson(Buffer.from(input)));
  assert.deepEqual(decodeNonDuplicateJson(Buffer.from('{"k": ["a", "b"]}')), { k: ["a", "b"] });
});
test("wire text and template parameters preserve the accepted C0/DEL boundary", () => {
  for (let code = 0; code <= 0x7f; code++) {
    const candidate = `a${String.fromCharCode(code)}b`;
    const forbidden = code === 0x7f || (code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code));
    const body = { ...text, textBody: candidate };
    if (forbidden) assert.throws(() => parseHumanSendInput(body), SendHttpError);
    else assert.doesNotThrow(() => parseHumanSendInput(body));
    assert.throws(() => parseHumanSendInput({ ...followUp, templateParameters: [candidate] }), SendHttpError);
  }
});
test("verified customer window is [inbound, inbound + 24h), with exact expiry", () => {
  const response = new Date("2026-10-10T01:00:00.000Z");
  const before = new Date("2026-10-11T00:59:59.999Z");
  const boundary = new Date("2026-10-11T01:00:00.000Z");
  assert.equal(windowOpen(null, before), false);
  assert.equal(windowOpen(response, before), true);
  assert.equal(windowOpen(response, boundary), false);
  assert.equal(windowOpen(response, new Date(boundary.getTime() + 1)), false);
  assert.equal(windowOpen(new Date(boundary.getTime() + 1), boundary), false);
});

test("configured follow-up due uses only the persisted due timestamp", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const initialSentAt = new Date(now.getTime() - 30 * 60_000);
  const shortDelayDue = new Date(initialSentAt.getTime() + 10 * 60_000);
  const longDelayDue = new Date(now.getTime() + 36 * 3600_000);
  // A merchant's configured 10-minute follow-up is due before S + 24 hours.
  assert.equal(configuredFollowUpDue(shortDelayDue, now), true);
  // A longer configured delay cannot be bypassed by elapsed 24 hours.
  assert.equal(configuredFollowUpDue(longDelayDue, now), false);
  assert.equal(configuredFollowUpDue(null, now), false);
  assert.equal(configuredFollowUpDue(new Date(now.getTime() + 1), now), false);
  assert.equal(configuredFollowUpDue(now, now), true);
  assert.equal(configuredFollowUpDue(new Date(Number.NaN), now), false);
  // Window closure remains a separate condition from due-time readiness.
  assert.equal(windowOpen(new Date(now.getTime() - 23 * 3600_000), now), true);
  assert.equal(windowOpen(new Date(now.getTime() - 24 * 3600_000), now), false);
});

test("HUMAN command status includes bounded safe moderation reason", () => {
  const status = { schemaVersion: 1, commandId: "cmd", conversationId: "convo", kind: "HUMAN_TEXT",
    state: "CANCELLED", createdAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-20T12:01:00.000Z",
    messageId: null, failureCode: null, moderationStatus: "moderation_blocked", moderationReasonCode: "moderation_blocked" };
  assert.equal(isSendStatusResponse(status), true);
  assert.equal(isSendStatusResponse({ ...status, moderationReasonCode: "moderation_violence_graphic" }), false);
  assert.equal(isSendStatusResponse({ ...status, moderationReasonCode: "sketchy", internal: "notes" }), false);
});
