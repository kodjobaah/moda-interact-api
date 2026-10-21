import assert from "node:assert/strict";
import test from "node:test";
import { publicModerationDecision, publicModerationReason } from "../../../../../src/merchant/conversations/moderation/read-projection.js";
import { messageModeration, readMessageModeration } from "../../../../../src/merchant/recoveries/detail/moderation.js";

test("moderation projection never exposes raw vendor category, scores or model identity", async () => {
  const database = { $queryRaw: async () => [
    { messageId: "m1", decision: "BLOCK", reasonCode: "moderation_violence_graphic" },
    { messageId: "m2", decision: "REVIEW_REQUIRED", reasonCode: "moderation_dependency_unavailable" },
    { messageId: "m3", decision: "ALLOW", reasonCode: null },
    { messageId: "foreign", decision: "BLOCK", reasonCode: "moderation_hate" },
  ] } as never;
  const results = await readMessageModeration(database, "shop", "conversation", ["m1", "m2", "m3", "m4"]);
  assert.deepEqual(messageModeration("m1", results), { moderationStatus: "BLOCK", moderationReasonCode: "moderation_blocked" });
  assert.deepEqual(messageModeration("m2", results), { moderationStatus: "REVIEW_REQUIRED", moderationReasonCode: "moderation_unavailable" });
  assert.deepEqual(messageModeration("m3", results), { moderationStatus: "ALLOW", moderationReasonCode: null });
  assert.deepEqual(messageModeration("m4", results), { moderationStatus: "PENDING", moderationReasonCode: null });
  assert.equal(results.has("foreign"), false);
});
test("unknown decision never becomes allow", () => {
  assert.equal(publicModerationDecision("CHECKING"), "PENDING");
  assert.equal(publicModerationDecision("UNEXPECTED"), "PENDING");
  assert.equal(publicModerationReason("RETRYABLE_ERROR", "internal_provider_failure"), "moderation_unavailable");
});
