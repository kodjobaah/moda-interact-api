import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

test("API-004 OpenAPI paths require Woo installation and preserve accepted-vs-sent semantics", () => {
  const source = readFileSync("openapi/merchant-conversation-human-send-v1.yaml", "utf8");
  const spec = YAML.parse(source) as Record<string, unknown>;
  const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
  const post = paths["/v1/merchant/conversations/{conversationId}/messages"]?.post;
  const get = paths["/v1/merchant/conversations/{conversationId}/send-commands/{commandId}"]?.get;
  const choices = paths["/v1/merchant/conversations/{conversationId}/follow-up-templates"]?.get;
  assert.ok(post && get && choices);
  assert.ok(post.responses && get.responses);
  assert.deepEqual(post.security, [{ InstallationBearer: [], InstallationId: [] }]);
  assert.deepEqual(get.security, [{ InstallationBearer: [], InstallationId: [] }]);
  assert.deepEqual(choices.security, [{ InstallationBearer: [], InstallationId: [] }]);
  assert.match(source, /maxItems: 30/);
  assert.match(source, /maxItems: 0/);
  assert.ok("202" in (post.responses as Record<string,unknown>));
  assert.ok("200" in (post.responses as Record<string,unknown>));
  assert.match(source, /moderation_pending/);
  assert.match(source, /moderationReasonCode/);
  assert.doesNotMatch(source, /moderationApproved:/);
});
