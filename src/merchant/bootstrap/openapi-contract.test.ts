import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { isMerchantBootstrapErrorResponse, isMerchantBootstrapResponse } from "./schema.js";
import { MERCHANT_BOOTSTRAP_ROUTE_PATH } from "../../woocommerce/installation/routes.js";

test("merchant bootstrap OpenAPI contract is strict, authenticated and versioned", async () => {
  const contractPath = new URL("../../../openapi/merchant-bootstrap-v1.yaml", import.meta.url);
  const document = parse(await readFile(fileURLToPath(contractPath), "utf8")) as BootstrapOpenApiDocument;
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.paths), [MERCHANT_BOOTSTRAP_ROUTE_PATH]);

  const operation = document.paths[MERCHANT_BOOTSTRAP_ROUTE_PATH]?.get;
  assert.ok(operation);
  assert.deepEqual(operation.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
  assert.deepEqual(Object.keys(operation.responses).sort(), ["200", "400", "401", "500"]);
  const bootstrapSchema = document.components.schemas.MerchantBootstrap;
  const contextSchema = document.components.schemas.InternationalContext;
  const categorySchema = document.components.schemas.CategoryIdentity;
  const unauthorizedResponse = document.components.responses.Unauthorized;
  assert.ok(bootstrapSchema);
  assert.ok(contextSchema);
  assert.ok(categorySchema);
  assert.ok(unauthorizedResponse);
  assert.equal(bootstrapSchema.additionalProperties, false);
  assert.deepEqual(bootstrapSchema.required, [
    "schemaVersion", "shop", "internationalContext", "storeProfile",
  ]);
  assert.equal(bootstrapSchema.properties.schemaVersion?.const, 1);
  for (const schemaName of ["ShopIdentity", "InternationalContext", "StoreProfile", "CategoryIdentity"]) {
    assert.equal(document.components.schemas[schemaName]?.additionalProperties, false, schemaName);
  }
  assert.deepEqual(contextSchema.required, [
    "storeLocale", "languageTag", "timeZone", "countryCode",
  ]);
  for (const [field, maximum] of Object.entries({
    storeLocale: 128,
    languageTag: 64,
    timeZone: 255,
    countryCode: 2,
  })) {
    assert.equal(contextSchema.properties[field]?.minLength, 1, `${field} minLength`);
    assert.equal(contextSchema.properties[field]?.maxLength, maximum, `${field} maxLength`);
  }
  assert.deepEqual(categorySchema.required, ["id", "slug", "displayName"]);
  assert.equal(categorySchema.properties.promptRevisionId, undefined);
  assert.equal(categorySchema.properties.description, undefined);
  assert.equal(unauthorizedResponse.content["application/json"].schema.$ref, "#/components/schemas/UnauthorizedError");
  assert.equal(isMerchantBootstrapErrorResponse({ error: "unauthorized" }), true);
  assert.equal(isMerchantBootstrapErrorResponse({ error: "database details" }), false);
  assert.equal(isMerchantBootstrapErrorResponse({ error: "unauthorized", detail: "secret" }), false);
});

test("merchant bootstrap runtime schema rejects empty non-null international context strings", () => {
  const response = {
    schemaVersion: 1 as const,
    shop: {
      id: "shop-1",
      platform: "WOOCOMMERCE" as const,
      domain: "https://merchant.example",
      onboardingCompleted: false,
      installedAt: "2026-10-02T10:00:00.000Z",
    },
    internationalContext: {
      storeLocale: "pt_BR",
      languageTag: "pt-BR",
      timeZone: "America/Sao_Paulo",
      countryCode: "BR",
    },
    storeProfile: {
      activeCategory: null,
      pendingCategory: null,
      pendingSelectionGeneration: 0,
      pendingSelectedAt: null,
    },
  };

  assert.equal(isMerchantBootstrapResponse(response), true);
  for (const field of ["storeLocale", "languageTag", "timeZone", "countryCode"] as const) {
    const invalidResponse = structuredClone(response);
    invalidResponse.internationalContext[field] = "";
    assert.equal(isMerchantBootstrapResponse(invalidResponse), false, field);
  }
});

interface BootstrapOpenApiDocument {
  openapi: string;
  paths: Record<string, { get?: {
    security?: Array<Record<string, string[]>>;
    responses: Record<string, unknown>;
  } }>;
  components: {
    schemas: Record<string, {
      additionalProperties?: boolean;
      required?: string[];
      const?: number;
      properties: Record<string, { const?: number; $ref?: string; minLength?: number; maxLength?: number }>;
    }>;
    responses: Record<string, {
      content: { "application/json": { schema: { $ref: string } } };
    }>;
  };
}