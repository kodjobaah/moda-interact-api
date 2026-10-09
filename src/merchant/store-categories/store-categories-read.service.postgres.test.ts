import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CommerceEnvironment, PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { StoreCategoriesReadService } from "./store-categories-read.service.js";
import { StoreCategoryReadError } from "./locale.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
let prisma: PrismaClient | undefined;
const database = () => prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl! } } });

test("disposable PostgreSQL category catalogue read retains active Shop profile and avoids billing/installation writes", {
  skip: !databaseUrl,
}, async () => {
  const url = `https://${randomUUID()}.woo-category.invalid`;
  const adminEmail = `${randomUUID()}@category.invalid`;
  let shopId: string | undefined;
  let categoryId: string | undefined;
  let templateId: string | undefined;
  let adminId: string | undefined;
  try {
    const shop = await database().shop.create({ data: {
      domain: url, platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true,
      storeLocale: "en_US", defaultLanguageTag: "en-US",
    } });
    shopId = shop.id;
    const installation = await database().wooCommerceInstallation.create({ data: {
      shopId, canonicalSiteUrl: url, credentialDigest: Buffer.alloc(32), credentialVersion: 1,
    } });
    const admin = await database().platformAdmin.create({ data: { email: adminEmail } });
    adminId = admin.id;
    const category = await database().commercePromptTemplateCategory.create({ data: {
      slug: randomUUID(), displayName: "Fashion", description: "Apparel", enabled: false,
      createdByAdminId: adminId, updatedByAdminId: adminId,
    } });
    categoryId = category.id;
    const prompt = await database().commercePromptTemplate.create({ data: {
      key: randomUUID(), categoryId, displayName: "Store prompt", promptText: "You assist apparel shoppers.",
      createdByAdminId: adminId, updatedByAdminId: adminId,
    } });
    templateId = prompt.id;
    await database().commercePromptTemplateCategory.update({ where: { id: categoryId }, data: {
      enabled: true, defaultTemplateId: prompt.id,
    } });
    await database().commercePromptTemplateCategoryTranslation.create({ data: {
      categoryId, locale: "en", displayName: "Clothing", description: "Clothes and accessories",
    } });
    const mapping = await database().commerceStoreCategoryTaxonomyMapping.create({ data: {
      categoryId, shopifyTaxonomyCategoryId: randomUUID(), conditionKey: "shoes", weight: 1,
    } });
    await database().commerceStoreCategoryTaxonomyMappingTranslation.create({ data: {
      mappingId: mapping.id, locale: "en", displayName: "Footwear",
    } });
    await database().commerceShopProfile.create({ data: {
      shopId, activeCategoryId: categoryId, pendingSelectionGeneration: 2,
    } });
    const initialProfile = await database().commerceShopProfile.findUnique({ where: { shopId } });
    const initialInstallation = await database().wooCommerceInstallation.findUnique({ where: { id: installation.id } });
    const principal: WooInstallationPrincipal = {
      shopId, installationId: installation.id, canonicalSiteUrl: url, credentialVersion: 1,
    };
    const service = new StoreCategoriesReadService(database(), CommerceEnvironment.TEST);
    const first = await service.read(principal, "en_GB");
    const second = await service.read(principal, "en_GB");
    assert.deepEqual(second, first);
    assert.equal(first.categories.some((entry) => entry.id === categoryId), true);
    assert.equal(first.categories.find((entry) => entry.id === categoryId)?.localizedDisplayName, "Clothing");
    assert.equal(first.categories.find((entry) => entry.id === categoryId)?.mappings[0]?.localizedDisplayName, "Footwear");
    assert.equal(first.storeProfile.activeCategory?.id, categoryId);
    assert.equal(first.storeProfile.pendingSelectionGeneration, 2);
    assert.deepEqual(await database().commerceShopProfile.findUnique({ where: { shopId } }), initialProfile);
    assert.deepEqual(await database().wooCommerceInstallation.findUnique({ where: { id: installation.id } }), initialInstallation);
    assert.equal(await database().subscription.count({ where: { shopId } }), 0);
    assert.equal(await database().shopEntitlementCounter.count({ where: { shopId } }), 0);
    await assert.rejects(service.read({ ...principal, credentialVersion: 2 }), StoreCategoryReadError);
  } finally {
    if (shopId) await database().shop.deleteMany({ where: { id: shopId } });
    if (categoryId) await database().commercePromptTemplateCategory.update({ where: { id: categoryId }, data: { defaultTemplateId: null } });
    if (templateId) await database().commercePromptTemplate.deleteMany({ where: { id: templateId } });
    if (categoryId) await database().commercePromptTemplateCategory.deleteMany({ where: { id: categoryId } });
    if (adminId) await database().platformAdmin.deleteMany({ where: { id: adminId } });
  }
});

after(async () => { await prisma?.$disconnect(); });
