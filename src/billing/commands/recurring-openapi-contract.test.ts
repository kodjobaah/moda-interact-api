import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { BILLING_SUBSCRIPTION_ROUTE_PATH, BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH } from "../../woocommerce/installation/routes.js";

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
      properties?: Record<string, { type?: string; const?: string; maxLength?: number }>;
    }>;
  };
}

test("recurring billing OpenAPI documents only the exact authenticated command contract", async () => {
  const contractPath = new URL("../../../openapi/woocommerce-billing-commands-v1.yaml", import.meta.url);
  const document = parse(await readFile(fileURLToPath(contractPath), "utf8")) as OpenApiCommandDocument;
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.paths).sort(), [BILLING_SUBSCRIPTION_ROUTE_PATH, BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH].sort());
  assert.deepEqual(Object.keys(document.paths[BILLING_SUBSCRIPTION_ROUTE_PATH] ?? {}).sort(), ["delete", "post"]);
  assert.deepEqual(Object.keys(document.paths[BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH] ?? {}).sort(), ["post"]);

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

  const create = document.paths[BILLING_SUBSCRIPTION_ROUTE_PATH]?.post;
  const switchPlan = document.paths[BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH]?.post;
  const cancel = document.paths[BILLING_SUBSCRIPTION_ROUTE_PATH]?.delete;
  assert.ok(create && switchPlan && cancel);
  for (const operation of [create, switchPlan, cancel]) {
    assert.deepEqual(operation.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
    assert.deepEqual(operation.parameters, [{ $ref: "#/components/parameters/IdempotencyKey" }]);
  }
  assert.deepEqual(Object.keys(create.responses).sort(), ["202", "400", "401", "409", "413", "422", "500", "502", "503"]);
  assert.deepEqual(Object.keys(switchPlan.responses).sort(), ["202", "400", "401", "409", "413", "422", "500", "502", "503"]);
  assert.deepEqual(Object.keys(cancel.responses).sort(), ["200", "400", "401", "409", "422", "500", "502", "503"]);
  const confirmationResult = document.components.schemas.ConfirmationResult;
  const cancellationResult = document.components.schemas.CancellationResult;
  const commandError = document.components.schemas.CommandError;
  assert.ok(confirmationResult && cancellationResult && commandError);
  assert.equal(confirmationResult.properties?.state?.const, "AWAITING_CONFIRMATION");
  assert.equal(cancellationResult.properties?.confirmationUrl?.type, "null");
  assert.equal(commandError.additionalProperties, false);
  assert.ok(commandError.properties?.providerErrorCode);
});
