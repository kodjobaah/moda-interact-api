import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { MERCHANT_STORE_CATEGORIES_ROUTE_PATH } from "./routes.js";

test("API-005 OpenAPI contract is read-only, authenticated, bounded and versioned", () => {
  const doc = parse(readFileSync(new URL("../../../openapi/merchant-store-categories-v1.yaml", import.meta.url), "utf8")) as {
    openapi: string;
    paths: Record<string, { get?: {
      operationId: string;
      security: Array<Record<string, unknown>>;
      parameters: Array<{ name: string; in: string; schema: { maxLength: number } }>;
      responses: Record<string, { content?: unknown }>;
    } }>;
    components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
  };
  assert.equal(doc.openapi, "3.1.0");
  assert.deepEqual(Object.keys(doc.paths), [MERCHANT_STORE_CATEGORIES_ROUTE_PATH]);
  const route = doc.paths[MERCHANT_STORE_CATEGORIES_ROUTE_PATH]?.get;
  assert.ok(route);
  assert.equal(route.operationId, "getMerchantStoreCategories");
  assert.deepEqual(route.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
  assert.deepEqual(route.parameters.map((parameter) => parameter.name), ["locale"]);
  assert.equal(route.parameters[0]?.schema.maxLength, 64);
  assert.ok(route.responses["200"]?.content);
  for (const status of ["400", "401", "409", "500"]) assert.ok(route.responses[status]);
  const schema = doc.components.schemas.StoreCategoriesReadResponse;
  assert.ok(schema);
  assert.deepEqual(schema.required, ["schemaVersion", "requestedLocale", "resolvedLocale", "categories", "storeProfile"]);
  assert.deepEqual(Object.keys(schema.properties ?? {}), schema.required);
  assert.equal(JSON.stringify(doc).includes("promptText"), false);
});
