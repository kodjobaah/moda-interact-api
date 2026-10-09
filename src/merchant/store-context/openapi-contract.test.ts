import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { isMerchantStoreContextSnapshot } from "./schema.js";
import { MERCHANT_STORE_CONTEXT_ROUTE_PATH } from "../../woocommerce/installation/routes.js";

test("versioned HTTP contract is strict, authenticated and matches the actual runtime snapshot", () => {
  const source = readFileSync(new URL("../../../openapi/merchant-store-context-v1.yaml", import.meta.url), "utf8");
  const document = parse(source) as {
    openapi: string;
    paths: Record<string, { put?: {
      operationId: string; security: Array<Record<string, unknown>>;
      parameters: unknown[];
      requestBody: { required: boolean; content: { "application/json": { schema: { $ref: string }; examples: { ukStore: { value: unknown } } } } };
      responses: Record<string, { content?: unknown }>;
    } }>;
    components: { schemas: Record<string, {
      additionalProperties: boolean; required: string[]; properties: Record<string, {
        maxLength?: number; minLength?: number; const?: number; pattern?: string;
      }>;
    }> };
  };
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.paths), [MERCHANT_STORE_CONTEXT_ROUTE_PATH]);
  const route = document.paths[MERCHANT_STORE_CONTEXT_ROUTE_PATH]?.put;
  assert.ok(route);
  assert.equal(route.operationId, "putMerchantStoreContext");
  assert.deepEqual(route.parameters, []);
  assert.deepEqual(route.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
  assert.equal(route.requestBody.required, true);
  assert.equal(route.requestBody.content["application/json"].schema.$ref, "#/components/schemas/MerchantStoreContextSnapshot");
  const example = route.requestBody.content["application/json"].examples.ukStore.value;
  assert.equal(isMerchantStoreContextSnapshot(example), true);
  const schema = document.components.schemas.MerchantStoreContextSnapshot;
  assert.ok(schema);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "storeLocale", "languageTag", "timeZone", "countryCode"]);
  assert.equal(schema.properties.schemaVersion?.const, 1);
  for (const [key, maximum] of Object.entries({ storeLocale: 128, languageTag: 64, timeZone: 255, countryCode: 2 })) {
    assert.equal(schema.properties[key]?.maxLength, maximum, key);
    assert.ok(schema.properties[key]?.pattern, key);
  }
  assert.ok(route.responses["204"]);
  assert.equal(route.responses["204"]?.content, undefined);
  for (const status of ["400", "401", "409", "413", "500"]) assert.ok(route.responses[status]);
});
