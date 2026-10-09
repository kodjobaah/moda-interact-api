import assert from "node:assert/strict";
import { CommerceEnvironment } from "@prisma/client";
import test from "node:test";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { StoreCategoriesReadService, commerceEnvironmentForApi } from "./store-categories-read.service.js";
import { StoreCategoryReadError } from "./locale.js";

const principal: WooInstallationPrincipal = {
  installationId: "installation_1", shopId: "shop_1", canonicalSiteUrl: "https://shop.example", credentialVersion: 2,
};
const template = { id: "template_1", key: "default", displayName: "Default", categoryId: "category_1", enabled: true, editVersion: 2, promptText: "Hello" };
const baseCategory = {
  id: "category_1", slug: "fashion", displayName: "Clothes", description: "Original",
  defaultTemplate: template,
  translations: [{ locale: "en", displayName: "Fashion", description: "Wearables" },
    { locale: "pt-BR", displayName: "Moda", description: "Vestuário" }],
  taxonomyMappings: [{ id: "map_1", conditionKey: "shoes", displayName: "Shoes", taxonomyCategoryName: "Shoes", translations: [] }],
};

function setup(overrides: { categories?: unknown[]; profile?: unknown; configurations?: unknown[]; shop?: object | null; installation?: object | null } = {}) {
  const calls: string[] = [];
  const database = {
    shop: { findUnique: async () => {
      calls.push("shop.findUnique");
      return overrides.shop === undefined ? { id: principal.shopId, domain: principal.canonicalSiteUrl,
        platform: "WOOCOMMERCE", shopifyShopId: null, status: "ACTIVE" } : overrides.shop;
    } },
    wooCommerceInstallation: { findUnique: async () => {
      calls.push("installation.findUnique");
      return overrides.installation === undefined ? { id: principal.installationId, shopId: principal.shopId,
        canonicalSiteUrl: principal.canonicalSiteUrl, credentialVersion: 2, status: "ACTIVE", revokedAt: null }
        : overrides.installation;
    } },
    commercePromptTemplateCategory: { findMany: async () => {
      calls.push("category.findMany");
      return overrides.categories ?? [baseCategory];
    } },
    commerceShopProfile: { findUnique: async () => {
      calls.push("profile.findUnique");
      return overrides.profile ?? null;
    } },
    commerceAgentConfiguration: { findMany: async () => {
      calls.push("configuration.findMany");
      return overrides.configurations ?? [];
    } },
  };
  return { service: new StoreCategoriesReadService(database as never, CommerceEnvironment.DEVELOPMENT), calls };
}

test("read-only empty profile, enabled category and translated mapping options", async () => {
  const { service, calls } = setup();
  const data = await service.read(principal, "pt_BR");
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.requestedLocale, "pt-BR");
  assert.equal(data.resolvedLocale, "pt-BR");
  assert.equal(data.categories[0]?.localizedDisplayName, "Moda");
  assert.equal(data.categories[0]?.localizedDescription, "Vestuário");
  assert.deepEqual(data.categories[0]?.mappings.map((mapping) => mapping.id), ["map_1"]);
  assert.deepEqual(data.storeProfile, {
    activeCategory: null, pendingCategory: null,
    pendingSelectionGeneration: 0, pendingSelectedAt: null,
    activeMappingIds: [], pendingMappingIds: [], pendingState: "NONE", pendingTemplate: null,
  });
  assert.equal(calls.length, 5);
  assert.equal(calls.some((value) => /write|update|create/i.test(value)), false);
});

test("catalogue excludes missing, disabled and cross-category default templates", async () => {
  const { service } = setup({ categories: [
    baseCategory,
    { ...baseCategory, id: "category_2", defaultTemplate: { ...template, enabled: false } },
    { ...baseCategory, id: "category_3", defaultTemplate: null },
    { ...baseCategory, id: "category_4", defaultTemplate: { ...template, categoryId: "wrong" } },
    { ...baseCategory, id: "category_5", defaultTemplate: { ...template, promptText: "  " } },
  ] });
  const data = await service.read(principal);
  assert.deepEqual(data.categories.map((category) => category.id), ["category_1"]);
});

test("active/pending profile and mapping IDs are resolved from each prompt's source provenance", async () => {
  const pendingContext = { schemaVersion: 1, kind: "STORE_CATEGORY_SELECTION", categoryId: "category_1", categoryEditVersion: 1, templateId: "template_1", templateEditVersion: 2, mappings: [{ mappingId: "map_1", mappingEditVersion: 1, conditionKey: "shoes" }] };
  const { service } = setup({
    profile: {
      shopId: principal.shopId, activeCategoryId: "category_1", pendingCategoryId: "category_1",
      pendingSelectionGeneration: 4, pendingSelectedAt: new Date("2026-10-09T12:00:00.000Z"),
      pendingPromptRevisionId: "revision_2", activeCategory: baseCategory, pendingCategory: baseCategory,
      pendingPromptRevision: { sourceContext: pendingContext, sourceTemplateEditVersion: 3,
        sourceTemplate: { id: "template_1", key: "default", displayName: "Default" } },
    },
    configurations: [{ activePromptRevision: { sourceContext: pendingContext } }],
  });
  const data = await service.read(principal);
  assert.equal(data.storeProfile.activeCategory?.localizedDisplayName, "Fashion");
  assert.equal(data.storeProfile.pendingCategory?.id, "category_1");
  assert.equal(data.storeProfile.pendingSelectionGeneration, 4);
  assert.equal(data.storeProfile.pendingState, "PENDING_PUBLICATION");
  assert.deepEqual(data.storeProfile.activeMappingIds, ["map_1"]);
  assert.deepEqual(data.storeProfile.pendingMappingIds, ["map_1"]);
  assert.equal(data.storeProfile.pendingTemplate?.editVersion, 3);
});

test("missing/revoked/mismatched Shop or installation cannot read profile or catalogue", async () => {
  for (const overrides of [{ shop: null }, { shop: { id: principal.shopId, domain: "https://other.example" } },
    { installation: { id: principal.installationId, shopId: principal.shopId, credentialVersion: 3 } }]) {
    const { service, calls } = setup(overrides);
    await assert.rejects(service.read(principal), StoreCategoryReadError);
    assert.equal(calls.includes("category.findMany"), false);
  }
});

test("missing profile can be retried; invalid profile and duplicate active configurations fail closed", async () => {
  await assert.rejects(setup({ profile: { shopId: principal.shopId, activeCategoryId: "category_1",
    activeCategory: null, pendingCategoryId: null, pendingPromptRevisionId: null, pendingSelectionGeneration: 0,
  } }).service.read(principal), StoreCategoryReadError);
  await assert.rejects(setup({ configurations: [{}, {}] }).service.read(principal), StoreCategoryReadError);
});

test("runtime environment is explicit and never inferred from Shopify process globals", () => {
  assert.equal(commerceEnvironmentForApi("local"), CommerceEnvironment.LOCAL);
  assert.equal(commerceEnvironmentForApi("production"), CommerceEnvironment.PRODUCTION);
  assert.throws(() => commerceEnvironmentForApi("unknown"));
});
