import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { MERCHANT_STORE_CATEGORY_SELECTION_ROUTE_PATH } from "./selection-routes.js";

test("API-006 OpenAPI contract is strict, bounded and uses active installation authentication", () => {
  const doc = parse(readFileSync(new URL("../../../openapi/merchant-store-category-selection-v1.yaml", import.meta.url), "utf8")) as {
    openapi: string;
    paths: Record<string, { post?: {
      security: Array<Record<string, unknown>>;
      requestBody: { content: { "application/json": { schema: { $ref: string } } } };
      responses: Record<string, unknown>;
    } }>;
    components: { schemas: Record<string, {
      required?: string[]; additionalProperties: boolean;
      properties: Record<string, { const?: number; maximum?: number; maxItems?: number; uniqueItems?: boolean }>;
    }> };
  };
  assert.equal(doc.openapi, "3.1.0");
  assert.deepEqual(Object.keys(doc.paths), [MERCHANT_STORE_CATEGORY_SELECTION_ROUTE_PATH]);
  const post = doc.paths[MERCHANT_STORE_CATEGORY_SELECTION_ROUTE_PATH]?.post;
  assert.ok(post);
  assert.deepEqual(post.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
  assert.equal(post.requestBody.content["application/json"].schema.$ref, "#/components/schemas/SelectionRequest");
  for (const status of ["200", "400", "401", "409", "413", "422", "500"]) assert.ok(post.responses[status]);
  const schema = doc.components.schemas.SelectionRequest;
  assert.ok(schema);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "categoryId", "selectedMappingIds", "expectedPendingSelectionGeneration"]);
  assert.equal(schema.properties.schemaVersion?.const, 1);
  assert.equal(schema.properties.selectedMappingIds?.maxItems, 50);
  assert.equal(schema.properties.selectedMappingIds?.uniqueItems, true);
  assert.equal(JSON.stringify(doc).includes("promptText"), false);
});
