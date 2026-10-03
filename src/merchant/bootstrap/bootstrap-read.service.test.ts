import assert from "node:assert/strict";
import test from "node:test";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { MerchantBootstrapIntegrityError, MerchantBootstrapReadService } from "./bootstrap-read.service.js";
import { isMerchantBootstrapResponse } from "./schema.js";

const principal: WooInstallationPrincipal = {
  installationId: "installation_1",
  shopId: "shop_authoritative",
  canonicalSiteUrl: "https://merchant.example",
  credentialVersion: 1,
};

function shop(overrides: Record<string, unknown> = {}) {
  return {
    id: principal.shopId,
    domain: principal.canonicalSiteUrl,
    platform: "WOOCOMMERCE",
    shopifyShopId: null,
    status: "ACTIVE",
    onboardingCompleted: false,
    installedAt: new Date("2026-10-02T10:00:00.000Z"),
    storeLocale: "pt_BR",
    defaultLanguageTag: null,
    defaultTimeZone: "America/Sao_Paulo",
    defaultCountryCode: "BR",
    commerceShopProfile: null,
    ...overrides,
  };
}

function makeService(row: unknown) {
  const calls: unknown[] = [];
  const database = {
    shop: {
      findUnique: async (query: unknown) => {
        calls.push(query);
        return row;
      },
    },
  };
  return { service: new MerchantBootstrapReadService(database as never), calls };
}

test("bootstrap reads only the authenticated Shop and projects bounded active/pending categories", async () => {
  const activeCategory = { id: "category_active", slug: "fashion", displayName: "Fashion" };
  const pendingCategory = { id: "category_pending", slug: "home-goods", displayName: "Home goods" };
  const row = shop({
    onboardingCompleted: true,
    defaultLanguageTag: "pt-BR",
    commerceShopProfile: {
      shopId: principal.shopId,
      activeCategoryId: activeCategory.id,
      activeCategory: activeCategory,
      pendingCategoryId: pendingCategory.id,
      pendingCategory: pendingCategory,
      pendingSelectionGeneration: 4,
      pendingSelectedAt: new Date("2026-10-03T12:30:00.000Z"),
    },
  });
  const { service, calls } = makeService(row);

  const response = await service.read(principal);
  assert.deepEqual(response, {
    schemaVersion: 1,
    shop: {
      id: principal.shopId,
      platform: "WOOCOMMERCE",
      domain: principal.canonicalSiteUrl,
      onboardingCompleted: true,
      installedAt: "2026-10-02T10:00:00.000Z",
    },
    internationalContext: {
      storeLocale: "pt_BR",
      languageTag: "pt-BR",
      timeZone: "America/Sao_Paulo",
      countryCode: "BR",
    },
    storeProfile: {
      activeCategory,
      pendingCategory,
      pendingSelectionGeneration: 4,
      pendingSelectedAt: "2026-10-03T12:30:00.000Z",
    },
  });
  assert.deepEqual(calls, [{
    where: { id: principal.shopId },
    select: {
      id: true,
      domain: true,
      platform: true,
      shopifyShopId: true,
      status: true,
      onboardingCompleted: true,
      installedAt: true,
      storeLocale: true,
      defaultLanguageTag: true,
      defaultTimeZone: true,
      defaultCountryCode: true,
      commerceShopProfile: {
        select: {
          shopId: true,
          activeCategoryId: true,
          activeCategory: { select: { id: true, slug: true, displayName: true } },
          pendingCategoryId: true,
          pendingCategory: { select: { id: true, slug: true, displayName: true } },
          pendingSelectionGeneration: true,
          pendingSelectedAt: true,
        },
      },
    },
  }]);
  assert.equal(JSON.stringify(response).includes("shopifyShopId"), false);
  assert.equal(JSON.stringify(response).includes("promptRevision"), false);
});

test("empty profile is returned without materializing it and preserves nullable shared context", async () => {
  const { service, calls } = makeService(shop({
    storeLocale: "zz_UNLISTED",
    defaultLanguageTag: null,
    defaultTimeZone: null,
    defaultCountryCode: null,
  }));
  const response = await service.read(principal);

  assert.equal(response.shop.onboardingCompleted, false);
  assert.deepEqual(response.internationalContext, {
    storeLocale: "zz_UNLISTED",
    languageTag: null,
    timeZone: null,
    countryCode: null,
  });
  assert.deepEqual(response.storeProfile, {
    activeCategory: null,
    pendingCategory: null,
    pendingSelectionGeneration: 0,
    pendingSelectedAt: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(isMerchantBootstrapResponse({ ...response, unexpected: true }), false);
  assert.equal(isMerchantBootstrapResponse({
    ...response,
    internationalContext: { ...response.internationalContext, unexpected: true },
  }), false);
});

test("missing or incompatible Shop and broken profile category references fail closed", async () => {
  const invalidRows = [
    null,
    shop({ platform: "SHOPIFY" }),
    shop({ shopifyShopId: "shopify_gid" }),
    shop({ status: "SUSPENDED" }),
    shop({ domain: "https://different.example" }),
    shop({ id: "different_shop" }),
    shop({ commerceShopProfile: {
      shopId: principal.shopId,
      activeCategoryId: "missing_category",
      activeCategory: null,
      pendingCategoryId: null,
      pendingCategory: null,
      pendingSelectionGeneration: 0,
      pendingSelectedAt: null,
    } }),
    shop({ commerceShopProfile: {
      shopId: principal.shopId,
      activeCategoryId: null,
      activeCategory: { id: "unexpected_category", slug: "unexpected", displayName: "Unexpected" },
      pendingCategoryId: null,
      pendingCategory: null,
      pendingSelectionGeneration: 0,
      pendingSelectedAt: null,
    } }),
    shop({ commerceShopProfile: {
      shopId: "other_shop",
      activeCategoryId: null,
      activeCategory: null,
      pendingCategoryId: null,
      pendingCategory: null,
      pendingSelectionGeneration: 0,
      pendingSelectedAt: null,
    } }),
  ];

  for (const row of invalidRows) {
    const { service } = makeService(row);
    await assert.rejects(service.read(principal), MerchantBootstrapIntegrityError);
  }
});