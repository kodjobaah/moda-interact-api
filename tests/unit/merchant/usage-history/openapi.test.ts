import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { USAGE_HISTORY_PATH } from "../../../../src/merchant/usage-history/contract.js";

interface UsageHistoryOpenApi {
  openapi: string;
  paths: Record<string, { get: {
    security: Array<Record<string, unknown>>;
    parameters: Array<{ name: string; schema: { enum?: number[] } }>;
    responses: Record<string, unknown>;
  } }>;
  components: { schemas: Record<string, {
    additionalProperties: boolean;
    properties: Record<string, { maxItems?: number; enum?: string[] }>;
    required?: string[];
    oneOf?: Array<{ $ref: string }>;
  }> };
}

test("API-022 OpenAPI exactly matches the Woo installation-only read, strict response and bounds", () => {
  const spec = parse(readFileSync("openapi/merchant-usage-history-v1.yaml", "utf8")) as UsageHistoryOpenApi;
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(Object.keys(spec.paths), [USAGE_HISTORY_PATH]);
  const path = spec.paths[USAGE_HISTORY_PATH];
  assert.ok(path);
  const get = path.get;
  assert.deepEqual(get.security, [{ InstallationBearer: [], InstallationId: [] }]);
  assert.deepEqual(get.parameters.map((p: { name: string }) => p.name),
    ["view", "periodId", "kind", "page", "pageSize", "periodCursor", "responseVersion"]);
  const pageSize = get.parameters.find((p) => p.name === "pageSize");
  assert.ok(pageSize);
  assert.deepEqual(pageSize.schema.enum, [10, 25, 50, 100]);
  for (const response of ["200", "400", "401", "409", "500"]) assert.ok(get.responses[response]);
  for (const name of ["UsageHistoryV1", "UsageHistoryV2", "UsageEventV2", "PeriodPage", "Period", "UsageEvent", "UsagePagination", "RecoverySource"]) {
    const schema = spec.components.schemas[name];
    assert.ok(schema, name);
    assert.equal(schema.additionalProperties, false, name);
  }
  const periodPage = spec.components.schemas.PeriodPage;
  const history = spec.components.schemas.UsageHistory;
  const historyV1 = spec.components.schemas.UsageHistoryV1;
  const historyV2 = spec.components.schemas.UsageHistoryV2;
  assert.ok(periodPage);
  assert.ok(history);
  assert.equal(periodPage.properties.items?.maxItems, 25);
  assert.deepEqual(history.oneOf, [
    { $ref: "#/components/schemas/UsageHistoryV1" },
    { $ref: "#/components/schemas/UsageHistoryV2" },
  ]);
  assert.equal(historyV1.properties.usageEvents?.maxItems, 100);
  assert.equal(historyV2.properties.usageEvents?.maxItems, 100);
  assert.deepEqual(historyV1.required,
    ["schemaVersion", "state", "usageView", "periodPage", "usageEvents", "usagePagination"]);
  assert.deepEqual(historyV2.required, historyV1.required);
  assert.ok(spec.components.schemas.UsageEventV2.required?.includes("chargedAgainst"));
  assert.deepEqual(spec.components.schemas.UsageEventV2.properties.chargedAgainst?.enum,
    ["LIFETIME_FREE_CREDITS", "INCLUDED_PLAN_ALLOWANCE", "PURCHASED_TOP_UP",
      "PROMOTIONAL_CREDITS", "NOT_APPLICABLE", "UNATTRIBUTED"]);
  for (const forbidden of ["shopId", "providerEventHandle", "idempotencyKey", "shopifyEventHandle", "providerReference", "providerSubscriptionId"]) {
    assert.equal(JSON.stringify(spec).includes(forbidden), false, forbidden);
  }
});
