import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { KNOWLEDGE_UPLOAD_FINALIZE_PATH, KNOWLEDGE_UPLOAD_INTENTS_PATH } from "../../../../src/merchant/merchant-knowledge/upload-contract.js";

const spec = YAML.parse(readFileSync(new URL("../../../../openapi/merchant-knowledge-v1.yaml", import.meta.url), "utf8"));

test("OpenAPI keeps the existing version-1 signed metadata contract, no-store across outcomes and strict Woo auth", () => {
  for (const path of [KNOWLEDGE_UPLOAD_INTENTS_PATH, KNOWLEDGE_UPLOAD_FINALIZE_PATH]) {
    const operation = spec.paths[path].post;
    assert.deepEqual(operation.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
    for (const [status, response] of Object.entries(operation.responses) as Array<[string, { headers?: Record<string, { schema: { const?: string } }> }]>) {
      assert.equal(response.headers?.["Cache-Control"]?.schema.const, "no-store", `${path}: ${status}`);
    }
  }
  const intent = spec.paths[KNOWLEDGE_UPLOAD_INTENTS_PATH].post;
  const response = intent.responses["200"].content["application/json"].schema;
  assert.deepEqual(new Set(response.required), new Set([
    "schemaVersion", "assetId", "uploadUrl", "expiresAt", "requiredHeaders", "maxUploadBytes",
  ]));
  assert.equal(response.properties.schemaVersion.const, 1);
  assert.equal(response.properties.requiredHeaders.additionalProperties, false);
  assert.deepEqual(new Set(response.properties.requiredHeaders.required),
    new Set(["Content-Type", "If-None-Match", "x-amz-meta-sha256"]));
  assert.equal(response.properties.requiredHeaders.properties["If-None-Match"].const, "*");
  assert.match(intent.description, /WordPress PHP.*brokers only metadata/s);
  assert.match(intent.description, /browser PUTs the Blob directly to the R2 HTTPS S3 API endpoint/s);
  assert.match(intent.description, /Browser OPTIONS preflight.*Gateway-owned/s);
  assert.match(spec.paths[KNOWLEDGE_UPLOAD_FINALIZE_PATH].post.description, /bounded GET streaming SHA-256 verification/);
});
