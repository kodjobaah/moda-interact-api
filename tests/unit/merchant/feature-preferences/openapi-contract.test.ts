import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { MERCHANT_FEATURE_PREFERENCES_PATH } from "../../../../src/merchant/feature-preferences/contract.js";

test("API-014 OpenAPI publishes strict versioned GET/PUT with Woo dual-header authentication", () => {
  const doc = parse(readFileSync(new URL("../../../../openapi/merchant-feature-preferences-v1.yaml", import.meta.url), "utf8")) as {
    openapi: string;
    paths: Record<string, Record<string, { security: Array<Record<string, unknown>>; requestBody?: unknown; responses: Record<string, unknown> }>>;
    components: { schemas: Record<string, { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }> };
  };
  assert.equal(doc.openapi, "3.1.0");
  assert.deepEqual(Object.keys(doc.paths), [MERCHANT_FEATURE_PREFERENCES_PATH]);
  for (const method of ["get", "put"]) {
    const route = doc.paths[MERCHANT_FEATURE_PREFERENCES_PATH]?.[method];
    assert.ok(route);
    assert.deepEqual(route.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
    for (const status of ["200", "400", "401", "409", "500"]) assert.ok(route.responses[status]);
  }
  assert.ok(doc.paths[MERCHANT_FEATURE_PREFERENCES_PATH]?.put?.requestBody);
  assert.ok(doc.paths[MERCHANT_FEATURE_PREFERENCES_PATH]?.put?.responses["413"]);
  for (const [name, required] of [
    ["FeaturePreferencesResponse", ["schemaVersion", "revision", "features"]],
    ["Feature", ["id", "key", "name", "description", "enabled", "effective", "editable", "required", "planEligible"]],
    ["FeaturePreferencesUpdate", ["expectedRevision", "changes"]],
    ["FeaturePreferenceChange", ["featureId", "enabled"]],
  ] as const) {
    const schema = doc.components.schemas[name];
    assert.ok(schema);
    assert.deepEqual(schema.required, required);
    assert.deepEqual(Object.keys(schema.properties), [...required]);
    assert.equal(schema.additionalProperties, false);
  }
});
