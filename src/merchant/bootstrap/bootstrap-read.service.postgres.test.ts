import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { MerchantBootstrapReadService } from "./bootstrap-read.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
let prisma: PrismaClient | undefined;

function database(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  return prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

function siteUrl(): string {
  return `https://${randomUUID()}.woo-bootstrap.invalid`;
}

function principal(shopId: string, canonicalSiteUrl: string): WooInstallationPrincipal {
  return { installationId: randomUUID(), shopId, canonicalSiteUrl, credentialVersion: 1 };
}

async function removeShop(shopId: string): Promise<void> {
  if (prisma) await prisma.shop.deleteMany({ where: { id: shopId } });
}

test("PostgreSQL bootstrap preserves uncompleted Woo onboarding, shared locale and an empty profile", {
  skip: !databaseUrl,
}, async () => {
  const domain = siteUrl();
  let shopId: string | undefined;
  try {
    const shop = await database().shop.create({
      data: {
        domain,
        platform: "WOOCOMMERCE",
        onboardingCompleted: false,
        storeLocale: "pt_BR",
        defaultLanguageTag: null,
        defaultTimeZone: "America/Sao_Paulo",
        defaultCountryCode: "BR",
      },
      select: { id: true },
    });
    shopId = shop.id;
    const beforeProfiles = await database().commerceShopProfile.count({ where: { shopId } });
    const response = await new MerchantBootstrapReadService(database()).read(principal(shopId, domain));

    assert.equal(response.shop.onboardingCompleted, false);
    assert.deepEqual(response.internationalContext, {
      storeLocale: "pt_BR",
      languageTag: null,
      timeZone: "America/Sao_Paulo",
      countryCode: "BR",
    });
    assert.deepEqual(response.storeProfile, {
      activeCategory: null,
      pendingCategory: null,
      pendingSelectionGeneration: 0,
      pendingSelectedAt: null,
    });
    assert.equal(await database().shopSettings.findUnique({ where: { shopId } }), null);
    assert.equal(await database().commerceShopProfile.count({ where: { shopId } }), beforeProfiles);

    await database().shop.update({ where: { id: shopId }, data: { onboardingCompleted: true } });
    assert.equal((await new MerchantBootstrapReadService(database()).read(principal(shopId, domain))).shop.onboardingCompleted, true);
    assert.equal(await database().shopSettings.findUnique({ where: { shopId } }), null);
  } finally {
    if (shopId) await removeShop(shopId);
  }
});

test("PostgreSQL bootstrap projects active and pending category identities without profile writes", {
  skip: !databaseUrl,
}, async () => {
  const domain = siteUrl();
  const email = `${randomUUID()}@bootstrap.invalid`;
  const categorySlugs = [randomUUID(), randomUUID()];
  let shopId: string | undefined;
  let adminId: string | undefined;
  let categoryIds: string[] = [];
  try {
    const shop = await database().shop.create({
      data: { domain, platform: "WOOCOMMERCE" },
      select: { id: true },
    });
    shopId = shop.id;
    const admin = await database().platformAdmin.create({ data: { email }, select: { id: true } });
    adminId = admin.id;
    const active = await database().commercePromptTemplateCategory.create({
      data: { slug: categorySlugs[0]!, displayName: "Active category", createdByAdminId: adminId, updatedByAdminId: adminId },
      select: { id: true, slug: true, displayName: true },
    });
    const pending = await database().commercePromptTemplateCategory.create({
      data: { slug: categorySlugs[1]!, displayName: "Pending category", createdByAdminId: adminId, updatedByAdminId: adminId },
      select: { id: true, slug: true, displayName: true },
    });
    categoryIds = [active.id, pending.id];
    await database().commerceShopProfile.create({
      data: {
        shopId,
        activeCategoryId: active.id,
        pendingCategoryId: pending.id,
        pendingSelectionGeneration: 3,
        pendingSelectedAt: new Date("2026-10-03T12:30:00.000Z"),
      },
    });
    const before = await database().commerceShopProfile.findUnique({ where: { shopId } });
    const response = await new MerchantBootstrapReadService(database()).read(principal(shopId, domain));
    const afterRead = await database().commerceShopProfile.findUnique({ where: { shopId } });

    assert.deepEqual(response.storeProfile, {
      activeCategory: active,
      pendingCategory: pending,
      pendingSelectionGeneration: 3,
      pendingSelectedAt: "2026-10-03T12:30:00.000Z",
    });
    assert.deepEqual(afterRead, before);
  } finally {
    if (shopId) await removeShop(shopId);
    if (categoryIds.length) await database().commercePromptTemplateCategory.deleteMany({ where: { id: { in: categoryIds } } });
    if (adminId) await database().platformAdmin.deleteMany({ where: { id: adminId } });
  }
});

after(async () => {
  await prisma?.$disconnect();
});