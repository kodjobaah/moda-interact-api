import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { MERCHANT_RECOVERY_POLICY_ROUTE_PATH } from "../../../../src/merchant/recovery-policy/contract.js";

test("API-002 exposes only strictly bounded Woo installation read/update and no coupon mutation", () => {
  const spec = parse(readFileSync(new URL("../../../../openapi/woocommerce-merchant-recovery-policy-v1.yaml", import.meta.url), "utf8")) as {
    openapi: string;
    paths: Record<string, Record<string, { operationId: string; security: Array<Record<string, unknown>>;
      parameters: unknown[]; responses: Record<string, unknown>; requestBody?: { content: { "application/json": { schema: { $ref: string } } } } }>>;
    components: { schemas: Record<string, { required: string[]; additionalProperties: boolean;
      properties: Record<string, unknown> }> };
  };
  assert.equal(spec.openapi, "3.1.0");
  assert.equal((spec as unknown as { info: { version: string } }).info.version, "2.0.0");
  assert.deepEqual(Object.keys(spec.paths), [MERCHANT_RECOVERY_POLICY_ROUTE_PATH]);
  const path = spec.paths[MERCHANT_RECOVERY_POLICY_ROUTE_PATH];
  assert.ok(path);
  assert.deepEqual(Object.keys(path), ["get", "put"]);
  for (const method of ["get", "put"] as const) {
    const route: {
      security: Array<Record<string, unknown>>;
      parameters: unknown[];
      responses: Record<string, unknown>;
    } | undefined = path[method];
    assert.ok(route);
    assert.deepEqual(route.security, [{ installationBearer: [] }]);
    assert.equal(route.parameters.length, 1);
    for (const code of ["200", "400", "401", "409", "500"]) assert.ok(route.responses[code]);
  }
  assert.ok(path.put?.responses["413"]);
  const update = spec.components.schemas.RecoveryPolicyUpdate;
  assert.ok(update);
  assert.equal(update.additionalProperties, false);
  assert.deepEqual([...update.required].sort(), ["expectedRevision", "recoveryDelayMinutes", "followUpEnabled",
    "followUpDelayMinutes", "notifyOnInitialRecoveryOutreach"].sort());
  assert.deepEqual(Object.keys(update.properties).sort(), [...update.required].sort());
  const response = spec.components.schemas.RecoveryPolicyResponse;
  assert.ok(response);
  assert.deepEqual([...response.required].sort(), ["schemaVersion", "revision", "merchant", "effective", "source",
    "overrideActive", "offerSelectionAvailable", "notifyOnInitialRecoveryOutreach"].sort());
  assert.deepEqual(Object.keys(response.properties).sort(), [...response.required].sort());
  assert.equal(response.additionalProperties, false);
  assert.equal(spec.components.schemas.RecoveryPolicyValues?.additionalProperties, false);
  const publicInterface = JSON.stringify(spec);
  for (const forbidden of ["shopId:", "fixedShopifyDiscountId", "shopifyDiscountNodeId", "PlatformAdminId", "checkoutToken", "phone:"]) {
    assert.equal(publicInterface.includes(forbidden), false, forbidden);
  }
});
