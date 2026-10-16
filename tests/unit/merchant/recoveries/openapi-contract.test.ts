import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { MERCHANT_RECOVERIES_ROUTE_PATH } from "../../../../src/merchant/recoveries/routes.js";

test("API-009 schema fixes pagination/filter bounds and installation-only shop authorisation", () => {
  const spec = parse(readFileSync(new URL("../../../../openapi/merchant-recoveries-v1.yaml", import.meta.url), "utf8")) as {
    openapi: string;
    paths: Record<string, { get: {
      operationId: string;
      security: Array<Record<string, unknown>>;
      parameters: Array<{ name: string; in: string; schema: Record<string, unknown> }>;
      responses: Record<string, unknown>;
    } }>;
    components: { schemas: Record<string, { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> }> };
  };
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(Object.keys(spec.paths), [MERCHANT_RECOVERIES_ROUTE_PATH]);
  const get = spec.paths[MERCHANT_RECOVERIES_ROUTE_PATH]?.get;
  assert.ok(get);
  assert.equal(get.operationId, "readMerchantRecoveries");
  assert.deepEqual(get.security, [{ installationBearer: [] }]);
  assert.deepEqual(get.parameters.map(({ name }) => name),
    ["X-Moda-Installation-Id", "from", "to", "q", "status", "page", "pageSize"]);
  assert.deepEqual(get.parameters.find(({ name }) => name === "pageSize")?.schema.enum, [10, 20, 25, 50]);
  assert.equal(get.parameters.find(({ name }) => name === "page")?.schema.maximum, 9999);
  for (const status of ["200", "400", "401", "409", "500"]) assert.ok(get.responses[status]);
  const response = spec.components.schemas.RecoveryListResponse;
  assert.ok(response);
  assert.equal(response.additionalProperties, false);
  assert.deepEqual(response.required,
    ["schemaVersion", "timeZone", "from", "to", "q", "status", "page", "pageSize", "total", "totalPages", "hasPrevious", "hasNext", "items"]);
  assert.deepEqual(Object.keys(response.properties), response.required);
  const recoveryItem = spec.components.schemas.RecoveryListItem;
  const recoveryCustomer = spec.components.schemas.RecoveryCustomer;
  assert.ok(recoveryItem);
  assert.ok(recoveryCustomer);
  assert.equal(recoveryItem.additionalProperties, false);
  assert.equal(recoveryCustomer.additionalProperties, false);
  const serialised = JSON.stringify(spec);
  for (const forbidden of ["shopId:", "checkoutUrl", "checkoutToken", "shopifyShopId", "phone:"]) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});
