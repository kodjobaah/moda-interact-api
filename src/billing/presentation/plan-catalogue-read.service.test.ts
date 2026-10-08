import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { BillingCatalogueError, BillingPlanCatalogueReadService } from "./plan-catalogue-read.service.js";

const principal: WooInstallationPrincipal = {
  installationId: "install_1",
  shopId: "shop_1",
  canonicalSiteUrl: "https://merchant.example",
  credentialVersion: 1,
};

const freePlan = {
  id: "mp_free",
  displayName: "Free",
  planKind: "FREE",
  cataloguePosition: 0,
  featured: false,
  includedRecoveryCredits: 5,
  allowancePeriod: "LIFETIME",
  billingPeriod: "EVERY_30_DAYS",
  recurringAmountMinor: 0,
  currency: "USD",
  translations: [{ locale: "en", merchantDescription: "Start free" }],
  highlights: [],
};

function makeService(plans: unknown[], defaultLanguageTag: string | null = null) {
  const logLines: string[] = [];
  const logger = createLogger({
    serviceName: "billing-test",
    environment: "test",
    sink: (line) => logLines.push(JSON.stringify(line)),
  });
  const database = {
    $transaction: (callback: (transaction: unknown) => Promise<unknown>) => callback({
      shop: { findUnique: async () => ({
        id: principal.shopId,
        domain: principal.canonicalSiteUrl,
        platform: "WOOCOMMERCE",
        shopifyShopId: null,
        status: "ACTIVE",
        onboardingCompleted: true,
        defaultLanguageTag,
      }) },
      merchantPricingPlan: { findMany: async () => plans },
    }),
  };
  return { service: new BillingPlanCatalogueReadService(database as never, logger), logLines };
}

test("plan catalogue resolves one complete locale for all plans and highlights", async () => {
  const growth = {
    ...freePlan,
    id: "mp_growth",
    displayName: "Growth",
    planKind: "PAID_METERED",
    cataloguePosition: 2,
    featured: true,
    allowancePeriod: "EVERY_30_DAYS",
    recurringAmountMinor: 4900,
    translations: [
      { locale: "en", merchantDescription: "Growth plan" },
      { locale: "pt", merchantDescription: "Plano Growth" },
    ],
    highlights: [{
      contentKey: "f93d600e-9ed9-4821-bcfe-c40dacabe1b9",
      position: 0,
      translations: [
        { locale: "en", merchantTitle: "More", merchantDescription: "More credits" },
        { locale: "pt", merchantTitle: "Mais", merchantDescription: "Mais créditos" },
      ],
    }],
  };
  const freeBilingual = {
    ...freePlan,
    translations: [
      { locale: "en", merchantDescription: "Start free" },
      { locale: "pt", merchantDescription: "Comece grátis" },
    ],
  };
  const { service } = makeService([freeBilingual, growth], "pt-BR");
  const response = await service.read(principal, "pt-BR");
  assert.equal(response.resolvedLocale, "pt");
  assert.equal(response.plans[1]?.localizedDescription, "Plano Growth");
  assert.equal(response.plans[1]?.highlights[0]?.title, "Mais");
  assert.equal(JSON.stringify(response).includes("shopifyPlanHandle"), false);
});

test("plan catalogue skips incompatible paid pricing, but requires exactly one Free plan", async () => {
  const incompatible = {
    ...freePlan,
    id: "mp_eur",
    planKind: "PAID_METERED",
    cataloguePosition: 1,
    allowancePeriod: "EVERY_30_DAYS",
    recurringAmountMinor: 1000,
    currency: "EUR",
  };
  const { service, logLines } = makeService([freePlan, incompatible]);
  const response = await service.read(principal);
  assert.deepEqual(response.plans.map((plan) => plan.merchantPricingPlanId), ["mp_free"]);
  assert.equal(logLines.length, 1);
  await assert.rejects(makeService([]).service.read(principal), (error: unknown) =>
    error instanceof BillingCatalogueError && error.code === "billing_catalogue_invalid",
  );
  await assert.rejects(makeService([freePlan, freePlan]).service.read(principal), (error: unknown) =>
    error instanceof BillingCatalogueError && error.code === "billing_catalogue_invalid",
  );
});

test("plan catalogue never mixes locales and rejects invalid presentation locale", async () => {
  const partial = {
    ...freePlan,
    highlights: [{
      contentKey: "a77fc9a2-5b0b-4f90-a80e-7da0a2206b5b",
      position: 0,
      translations: [{ locale: "fr", merchantTitle: "Titre", merchantDescription: "Description" }],
    }],
  };
  await assert.rejects(makeService([partial]).service.read(principal, "fr-CA"), (error: unknown) =>
    error instanceof BillingCatalogueError && error.code === "billing_catalogue_translation_unavailable",
  );
  await assert.rejects(makeService([freePlan]).service.read(principal, "bad_tag_@@"), (error: unknown) =>
    error instanceof BillingCatalogueError && error.code === "billing_locale_invalid",
  );
});