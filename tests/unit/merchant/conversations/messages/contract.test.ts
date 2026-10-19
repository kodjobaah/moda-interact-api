import assert from "node:assert/strict";
import test from "node:test";
import { parseHumanSendInput, humanPayloadDigest, SendHttpError } from "../../../../../src/merchant/conversations/messages/contract.js";
import { decodeNonDuplicateJson } from "../../../../../src/merchant/conversations/messages/request.js";
import { merchantFollowUpWindowClosed, windowOpen } from "../../../../../src/merchant/conversations/messages/eligibility.js";

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
    for (const body of [
      { ...text, textBody: candidate },
      { ...followUp, templateParameters: [candidate] },
    ]) {
      if (forbidden) assert.throws(() => parseHumanSendInput(body), SendHttpError);
      else assert.doesNotThrow(() => parseHumanSendInput(body));
    }
  }
});
test("customer window and post-window boundaries are exact", () => {
  const initial = new Date("2026-10-10T00:00:00.000Z");
  const response = new Date("2026-10-10T01:00:00.000Z");
  const before = new Date("2026-10-11T00:59:59.999Z");
  const boundary = new Date("2026-10-11T01:00:00.000Z");
  assert.equal(windowOpen(null, before), false);
  assert.equal(windowOpen(response, before), true);
  assert.equal(windowOpen(response, boundary), false);
  assert.equal(merchantFollowUpWindowClosed(initial, response, before), false);
  assert.equal(merchantFollowUpWindowClosed(initial, response, boundary), true);
  assert.equal(merchantFollowUpWindowClosed(initial, null, new Date("2026-10-11T00:00:00Z")), true);
});
