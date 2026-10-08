import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import {
  BILLING_ERROR_CODES,
  isBillingErrorResponse,
  isBillingPlanCatalogueResponse,
  isBillingPresentationResponse,
} from "./schemas.js";
import { BILLING_PLANS_ROUTE_PATH, BILLING_PRESENTATION_ROUTE_PATH } from "../../woocommerce/installation/routes.js";

test("billing OpenAPI 3.1 matches both authenticated strict GET contracts", async () => {
  const path = new URL("../../../openapi/woocommerce-billing-presentation-v1.yaml", import.meta.url);
  const document = parse(await readFile(fileURLToPath(path), "utf8")) as Record<string, unknown>;
  const installationPath = new URL("../../../openapi/woocommerce-installation-v1.yaml", import.meta.url);
  const installationDocument = parse(await readFile(fileURLToPath(installationPath), "utf8")) as Record<string, unknown>;
  const bootstrapPath = new URL("../../../openapi/merchant-bootstrap-v1.yaml", import.meta.url);
  const bootstrapDocument = parse(await readFile(fileURLToPath(bootstrapPath), "utf8")) as Record<string, unknown>;
  const paths = document.paths as Record<string, unknown>;
  const components = document.components as Record<string, unknown>;
  const schemas = components.schemas as Record<string, Record<string, unknown>>;
  assert.equal(document.openapi, "3.1.0");
  assert.equal(
    ((document.servers as Array<Record<string, unknown>>)[0])?.url,
    ((installationDocument.servers as Array<Record<string, unknown>>)[0])?.url,
  );
  assert.equal(
    ((document.servers as Array<Record<string, unknown>>)[0])?.url,
    ((bootstrapDocument.servers as Array<Record<string, unknown>>)[0])?.url,
  );
  assert.deepEqual(Object.keys(paths).sort(), [BILLING_PLANS_ROUTE_PATH, BILLING_PRESENTATION_ROUTE_PATH].sort());
  assert.equal(paths[BILLING_PRESENTATION_ROUTE_PATH] && paths[BILLING_PLANS_ROUTE_PATH] ? true : false, true);

  for (const pathName of [BILLING_PRESENTATION_ROUTE_PATH, BILLING_PLANS_ROUTE_PATH]) {
    const operation = (paths[pathName] as Record<string, unknown>).get as Record<string, unknown>;
    assert.deepEqual(operation.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
    assert.deepEqual(Object.keys(operation.responses as Record<string, unknown>).sort(), ["200", "400", "401", "409", "500"]);
  }
  const parameters = ((paths[BILLING_PLANS_ROUTE_PATH] as Record<string, unknown>).get as Record<string, unknown>)
    .parameters as Array<Record<string, unknown>>;
  assert.equal(parameters.length, 1);
  assert.equal(parameters[0]?.name, "locale");
  assert.equal((parameters[0]?.schema as Record<string, unknown>).maxLength, 64);
  assert.deepEqual(schemas.BillingError?.properties &&
    ((schemas.BillingError.properties as Record<string, Record<string, unknown>>).error?.enum),
  [...BILLING_ERROR_CODES]);
  for (const schema of Object.values(schemas)) {
    if (schema.type === "object") assert.equal(schema.additionalProperties, false);
  }
});

test("billing runtime schemas reject provider fields and unknown nested properties", () => {
  const billing = {
    schemaVersion: 1,
    experienceState: "ACTIVE",
    surfaces: {
      usageHistoryAllowed: true,
      purchaseHistoryAllowed: true,
      managePlansAllowed: true,
      cancelSubscriptionAllowed: false,
    },
    currentPlan: null,
    pendingPlan: null,
    pendingCancellation: null,
    capacity: {
      paidIncluded: null,
      freeLifetime: { granted: 2, committed: 0, reserved: 0, remaining: 2 },
      promotional: { granted: 0, committed: 0, reserved: 0, remaining: 0 },
      purchased: { granted: 0, committed: 0, reserved: 0, refunding: 0, available: 0 },
    },
    topUps: { configured: false, purchaseEligible: false, offers: [], latestPurchase: null, unresolvedPurchases: [] },
  };
  const catalogue = {
    schemaVersion: 1,
    resolvedLocale: "en",
    plans: [{
      merchantPricingPlanId: "mp_free",
      displayName: "Free",
      planKind: "FREE",
      cataloguePosition: 0,
      featured: false,
      localizedDescription: "Start free",
      includedRecoveryCredits: 5,
      allowancePeriod: "LIFETIME",
      billingPeriod: "EVERY_30_DAYS",
      recurringAmountMinor: 0,
      currency: "USD",
      highlights: [],
    }],
  };
  assert.equal(isBillingPresentationResponse(billing), true);
  assert.equal(isBillingPlanCatalogueResponse(catalogue), true);
  assert.equal(isBillingErrorResponse({ error: "billing_operation_conflict" }), true);
  assert.equal(isBillingErrorResponse({ error: "providerReference" }), false);
  assert.equal(isBillingPresentationResponse({ ...billing, providerSubscriptionId: "secret" }), false);
  assert.equal(isBillingPlanCatalogueResponse({ ...catalogue, plans: [{ ...catalogue.plans[0], shopifyPlanHandle: "secret" }] }), false);
  assert.equal(isBillingPresentationResponse({
    ...billing,
    capacity: { ...billing.capacity, freeLifetime: { ...billing.capacity.freeLifetime, leaked: true } },
  }), false);
});