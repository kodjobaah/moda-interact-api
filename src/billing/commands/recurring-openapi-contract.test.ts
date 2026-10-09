import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import {
  BILLING_RECOVERY_CREDIT_PURCHASES_ROUTE_PATH,
  BILLING_SUBSCRIPTION_ROUTE_PATH,
  BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH,
} from "../../woocommerce/installation/routes.js";

interface OpenApiCommandDocument {
  openapi: string;
  paths: Record<string, {
    post?: { parameters?: Array<{ $ref?: string }>; requestBody?: unknown; responses: Record<string, unknown>; security?: Array<Record<string, string[]>> };
    delete?: { parameters?: Array<{ $ref?: string }>; responses: Record<string, unknown>; security?: Array<Record<string, string[]>> };
  }>;
  components: {
    parameters: Record<string, { name: string; in: string; required: boolean; schema: { minLength: number; maxLength: number; pattern: string } }>;
    schemas: Record<string, {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, { type?: string; const?: string; enum?: string[]; maxLength?: number }>;
    }>;
  };
}

test("recurring billing OpenAPI documents only the exact authenticated command contract", async () => {
  const contractPath = new URL("../../../openapi/woocommerce-billing-commands-v1.yaml", import.meta.url);
  const document = parse(await readFile(fileURLToPath(contractPath), "utf8")) as OpenApiCommandDocument;
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.paths).sort(), [
    BILLING_RECOVERY_CREDIT_PURCHASES_ROUTE_PATH,
    BILLING_SUBSCRIPTION_ROUTE_PATH,
    BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH,
  ].sort());
  assert.deepEqual(Object.keys(document.paths[BILLING_SUBSCRIPTION_ROUTE_PATH] ?? {}).sort(), ["delete", "post"]);
  assert.deepEqual(Object.keys(document.paths[BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH] ?? {}).sort(), ["post"]);
  assert.deepEqual(Object.keys(document.paths[BILLING_RECOVERY_CREDIT_PURCHASES_ROUTE_PATH] ?? {}).sort(), ["post"]);

  const idempotency = document.components.parameters.IdempotencyKey;
  assert.ok(idempotency);
  assert.deepEqual([idempotency.name, idempotency.in, idempotency.required], ["Idempotency-Key", "header", true]);
  assert.deepEqual([idempotency.schema.minLength, idempotency.schema.maxLength], [1, 128]);
  assert.equal(idempotency.schema.pattern, "^[A-Za-z0-9._:-]+$");
  const body = document.components.schemas.RecurringPlanRequest;
  assert.ok(body);
  assert.equal(body.additionalProperties, false);
  assert.deepEqual(body.required, ["merchantPricingPlanId"]);
  assert.deepEqual(Object.keys(body.properties ?? {}), ["merchantPricingPlanId"]);

  const purchaseBody = document.components.schemas.RecoveryCreditPurchaseRequest;
  assert.ok(purchaseBody);
  assert.equal(purchaseBody.additionalProperties, false);
  assert.deepEqual(purchaseBody.required, ["merchantPricingUsageEventId"]);
  assert.deepEqual(Object.keys(purchaseBody.properties ?? {}), ["merchantPricingUsageEventId"]);

  const create = document.paths[BILLING_SUBSCRIPTION_ROUTE_PATH]?.post;
  const switchPlan = document.paths[BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH]?.post;
  const cancel = document.paths[BILLING_SUBSCRIPTION_ROUTE_PATH]?.delete;
  const recoveryCreditPurchase = document.paths[BILLING_RECOVERY_CREDIT_PURCHASES_ROUTE_PATH]?.post;
  assert.ok(create && switchPlan && cancel && recoveryCreditPurchase);
  for (const operation of [create, switchPlan, cancel]) {
    assert.deepEqual(operation.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
    assert.deepEqual(operation.parameters, [{ $ref: "#/components/parameters/IdempotencyKey" }]);
  }
  assert.deepEqual(Object.keys(create.responses).sort(), ["200", "202", "400", "401", "409", "413", "422", "500", "502", "503"]);
  assert.deepEqual(Object.keys(switchPlan.responses).sort(), ["200", "202", "400", "401", "409", "413", "422", "500", "502", "503"]);
  assert.deepEqual(Object.keys(cancel.responses).sort(), ["200", "400", "401", "409", "422", "500", "502", "503"]);
  assert.deepEqual(Object.keys(recoveryCreditPurchase.responses).sort(), ["200", "202", "400", "401", "404", "409", "413", "422", "500", "502", "503"]);
  assert.deepEqual(recoveryCreditPurchase.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
  assert.deepEqual(recoveryCreditPurchase.parameters, [{ $ref: "#/components/parameters/IdempotencyKey" }]);
  const confirmationResult = document.components.schemas.ConfirmationResult;
  const cancellationResult = document.components.schemas.CancellationResult;
  const commandError = document.components.schemas.CommandError;
  const purchaseResult = document.components.schemas.RecoveryCreditPurchaseResult;
  assert.ok(confirmationResult && cancellationResult && commandError && purchaseResult);
  assert.deepEqual(confirmationResult.properties?.state?.enum, ["AWAITING_CONFIRMATION", "CONFIRMED"]);
  assert.deepEqual(purchaseResult.properties?.state?.enum, ["AWAITING_CONFIRMATION", "CONFIRMED"]);
  assert.deepEqual(purchaseResult.required, ["schemaVersion", "purchaseId", "operationId", "state", "confirmationUrl"]);
  assert.equal(cancellationResult.properties?.confirmationUrl?.type, "null");
  assert.equal(commandError.additionalProperties, false);
  assert.ok(commandError.properties?.providerErrorCode);
  assert.ok(commandError.properties?.purchaseId);
});
