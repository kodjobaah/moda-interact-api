import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("Woo conversation control OpenAPI declares bounded CAS body, responses and dual installation auth", () => {
  const document = parse(readFileSync(new URL("../../../../../openapi/merchant-conversation-control-v1.yaml", import.meta.url), "utf8")) as {
    openapi: string;
    paths: Record<string, { post: { security: unknown; responses: Record<string, unknown>; requestBody: unknown } }>;
    components: { schemas: Record<string, { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> }> };
  };
  assert.equal(document.openapi, "3.1.0");
  const path = "/v1/merchant/conversations/{conversationId}/control";
  assert.deepEqual(Object.keys(document.paths), [path]);
  assert.deepEqual(document.paths[path]?.post.security, [{ InstallationBearer: [], InstallationId: [] }]);
  for (const status of ["200", "400", "401", "403", "404", "409", "413", "500"]) assert.ok(document.paths[path]?.post.responses[status]);
  assert.ok(document.paths[path]?.post.requestBody);
  for (const [name, keys] of [
    ["ControlCommand", ["targetMode", "expectedControlRevision"]],
    ["ControlSnapshot", ["schemaVersion", "conversationId", "controlMode", "controlRevision", "controlChangedAt"]],
  ] as const) {
    const schema = document.components.schemas[name];
    assert.ok(schema);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, [...keys]);
    assert.deepEqual(Object.keys(schema.properties), [...keys]);
  }
});
