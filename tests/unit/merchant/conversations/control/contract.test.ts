import assert from "node:assert/strict";
import test from "node:test";
import { parseControlRequest, ConversationControlRequestError, validControlResponse, validConversationId } from "../../../../../src/merchant/conversations/control/contract.js";

const rejected = (value: unknown) => assert.throws(() => parseControlRequest(value), ConversationControlRequestError);

test("strict schema accepts only targetMode and nonnegative safe revision", () => {
  assert.deepEqual(parseControlRequest({ targetMode: "AI", expectedControlRevision: 0 }),
    { targetMode: "AI", expectedControlRevision: 0 });
  assert.deepEqual(parseControlRequest({ expectedControlRevision: 2147483647, targetMode: "HUMAN" }),
    { targetMode: "HUMAN", expectedControlRevision: 2147483647 });
  for (const value of [null, [], {}, { targetMode: "human", expectedControlRevision: 1 },
    { targetMode: "HUMAN", expectedControlRevision: -1 },
    { targetMode: "HUMAN", expectedControlRevision: 1.2 },
    { targetMode: "HUMAN", expectedControlRevision: "1" },
    { targetMode: "HUMAN", expectedControlRevision: Number.MAX_SAFE_INTEGER },
    { targetMode: "HUMAN", expectedControlRevision: 0, shopId: "other" },
    { targetMode: "HUMAN", expectedControlRevision: 0, actorPlatform: "WOOCOMMERCE" },
    { targetMode: "AI", expectedControlRevision: 0, actorSubject: "staff" }]) rejected(value);
});

test("control IDs and response schema cannot smuggle extra fields", () => {
  assert.equal(validConversationId("aB_09-foo"), true);
  for (const id of ["", "../other", "abc%2Fdef", "hi!", "x".repeat(192)]) assert.equal(validConversationId(id), false);
  const response = { schemaVersion: 1, conversationId: "conv-1", controlMode: "AI", controlRevision: 0, controlChangedAt: null };
  assert.equal(validControlResponse(response), true);
  assert.equal(validControlResponse({ ...response, accessToken: "secret" }), false);
  assert.equal(validControlResponse({ ...response, controlRevision: -1 }), false);
});
