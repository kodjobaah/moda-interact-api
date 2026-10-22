import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { PROMOTIONS_PATH, PROMOTION_SELECTION_PATH } from "../../../../src/merchant/promotions/contract.js";

test("promotion OpenAPI documents strict paths, authentication and full credit state", () => {
  const doc = parse(readFileSync(new URL("../../../../openapi/merchant-promotions-v1.yaml", import.meta.url), "utf8")) as {
    openapi: string;
    paths: Record<string, Record<string, {
      security: unknown[]; parameters?: Array<{ name: string }>; responses: Record<string, unknown>;
    }>>;
    components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
  };
  assert.equal(doc.openapi, "3.1.0");
  assert.deepEqual(Object.keys(doc.paths).sort(), [PROMOTIONS_PATH, PROMOTION_SELECTION_PATH].sort());
  const get = doc.paths[PROMOTIONS_PATH]?.get;
  const put = doc.paths[PROMOTION_SELECTION_PATH]?.put;
  assert.ok(get && put);
  assert.deepEqual(get.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
  assert.deepEqual(put.security, get.security);
  assert.deepEqual(get.parameters?.map((item) => item.name), ["offerPage", "historyPage", "locale"]);
  for (const code of ["200", "400", "401", "409", "500"]) assert.ok(get.responses[code]);
  for (const code of ["200", "400", "401", "409", "413", "422", "500"]) assert.ok(put.responses[code]);
  const selectionRequest = doc.components.schemas.SelectionRequest;
  const readResponse = doc.components.schemas.ReadResponse;
  const selectionSchema = doc.components.schemas.Selection;
  assert.ok(selectionRequest);
  assert.ok(readResponse);
  assert.ok(selectionSchema);
  assert.deepEqual(selectionRequest.required, ["campaignId", "expectedRevision"]);
  assert.deepEqual(readResponse.required,
    ["schemaVersion", "revision", "offers", "offersPagination", "selection", "history"]);
  assert.ok(selectionSchema.required?.includes("committedQuantity"));
  assert.ok(selectionSchema.required?.includes("reservedQuantity"));
  assert.equal(JSON.stringify(doc).includes("shopId: {"), false);
});
