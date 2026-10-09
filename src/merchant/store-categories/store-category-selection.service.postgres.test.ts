import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CommerceEnvironment, Prisma, PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { StoreCategoriesReadService } from "./store-categories-read.service.js";
import { StoreCategorySelectionError } from "./selection-errors.js";
import { StoreCategorySelectionService } from "./store-category-selection.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
let prisma: PrismaClient | undefined;
function db(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL required");
  return prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}
const environment = CommerceEnvironment.TEST;

interface CategoryFixture {
  id: string;
  templateId: string;
  mappingId: string;
}
interface Fixture {
  shopId: string;
  installationId: string;
  adminId: string;
  planId: string;
  principal: WooInstallationPrincipal;
  first: CategoryFixture;
  second: CategoryFixture;
}

async function makeCategory(adminId: string, label: string): Promise<CategoryFixture> {
  const category = await db().commercePromptTemplateCategory.create({ data: {
    slug: randomUUID(), displayName: label, enabled: false,
    createdByAdminId: adminId, updatedByAdminId: adminId,
  } });
  const template = await db().commercePromptTemplate.create({ data: {
    key: randomUUID(), categoryId: category.id, displayName: label,
    promptText: `Welcome to ${label}. {% if mappings.shoes %}Footwear available.{% else %}General products.{% endif %}`,
    createdByAdminId: adminId, updatedByAdminId: adminId,
  } });
  await db().commercePromptTemplateCategory.update({ where: { id: category.id }, data: { defaultTemplateId: template.id, enabled: true } });
  const mapping = await db().commerceStoreCategoryTaxonomyMapping.create({ data: {
    categoryId: category.id, shopifyTaxonomyCategoryId: randomUUID(), conditionKey: "shoes",
  } });
  return { id: category.id, templateId: template.id, mappingId: mapping.id };
}

async function fixture(): Promise<Fixture> {
  const siteUrl = `https://${randomUUID()}.woo-category.invalid`;
  const plan = await db().billingPlan.create({ data: {
    shopifyPlanHandle: `woo-category-${randomUUID()}`, name: "Woo category fixture", kind: "FREE", active: true,
  } });
  const shop = await db().shop.create({ data: {
    domain: siteUrl, platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true,
  } });
  const installation = await db().wooCommerceInstallation.create({ data: {
    shopId: shop.id, canonicalSiteUrl: siteUrl, credentialDigest: Buffer.alloc(32), credentialVersion: 1,
  } });
  await db().subscription.create({ data: { shopId: shop.id, planId: plan.id, status: "ACTIVE" } });
  await db().shopEntitlementCounter.create({ data: {
    shopId: shop.id, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
    grantedQuantity: 5, committedQuantity: 1, reservedQuantity: 1,
  } });
  const admin = await db().platformAdmin.create({ data: { email: `${randomUUID()}@category.invalid` } });
  const first = await makeCategory(admin.id, "Fashion");
  const second = await makeCategory(admin.id, "Home");
  return {
    shopId: shop.id, installationId: installation.id, adminId: admin.id, planId: plan.id, first, second,
    principal: { shopId: shop.id, installationId: installation.id, canonicalSiteUrl: siteUrl, credentialVersion: 1 },
  };
}

async function cleanup(f: Fixture): Promise<void> {
  await db().commerceAgentConfiguration.deleteMany({ where: { shopId: f.shopId } });
  await db().commerceShopProfile.deleteMany({ where: { shopId: f.shopId } });
  const prompts = await db().commerceAgentPrompt.findMany({ where: { shopId: f.shopId }, select: { id: true } });
  const promptIds = prompts.map((prompt) => prompt.id);
  await db().commerceAgentPromptRevision.deleteMany({ where: { promptId: { in: promptIds } } });
  await db().commerceAgentPrompt.deleteMany({ where: { id: { in: promptIds } } });
  await db().shop.delete({ where: { id: f.shopId } });
  for (const category of [f.first, f.second]) {
    await db().commercePromptTemplateCategory.update({ where: { id: category.id }, data: { defaultTemplateId: null } });
    await db().commerceStoreCategoryTaxonomyMapping.deleteMany({ where: { categoryId: category.id } });
    await db().commercePromptTemplate.deleteMany({ where: { id: category.templateId } });
    await db().commercePromptTemplateCategory.deleteMany({ where: { id: category.id } });
  }
  await db().platformAdmin.delete({ where: { id: f.adminId } });
  await db().billingPlan.delete({ where: { id: f.planId } });
}

function service() { return new StoreCategorySelectionService(db(), environment); }
function command(f: Fixture, category: CategoryFixture, generation: number, mappingIds = [category.mappingId]) {
  return { schemaVersion: 1 as const, categoryId: category.id,
    selectedMappingIds: mappingIds, expectedPendingSelectionGeneration: generation };
}

async function protectedState(f: Fixture) {
  return {
    shop: await db().shop.findUniqueOrThrow({ where: { id: f.shopId } }),
    installation: await db().wooCommerceInstallation.findUniqueOrThrow({ where: { id: f.installationId } }),
    subscription: await db().subscription.findUniqueOrThrow({ where: { shopId: f.shopId } }),
    counter: await db().shopEntitlementCounter.findUniqueOrThrow({
      where: { shopId_counter: { shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
    }),
  };
}

test("PostgreSQL first Woo category save publishes immediately; later replacement preserves billing and credentials", {
  skip: !databaseUrl,
}, async () => {
  const f = await fixture();
  try {
    const before = await protectedState(f);
    const first = await service().select(f.principal, command(f, f.first, 0));
    assert.equal(first.pendingSelectionGeneration, 1);
    assert.equal(first.activeCategoryId, f.first.id);
    const profile = await db().commerceShopProfile.findUniqueOrThrow({ where: { shopId: f.shopId } });
    assert.equal(profile.activeCategoryId, f.first.id);
    assert.equal(profile.pendingCategoryId, null);
    assert.equal(profile.pendingPromptRevisionId, null);
    assert.equal(profile.pendingSelectedAt, null);
    const config = await db().commerceAgentConfiguration.findFirstOrThrow({
      where: { shopId: f.shopId, environment, scope: "SHOP" },
    });
    assert.equal(config.activePromptRevisionId, first.activePromptRevisionId);
    const published = await db().commerceAgentPromptRevision.findUniqueOrThrow({ where: { id: first.activePromptRevisionId } });
    assert.equal(published.status, "PUBLISHED");
    assert.equal(published.sourceTemplateId, f.first.templateId);
    assert.ok(published.promptText.includes("Footwear available."));
    assert.equal(published.contentHash?.length, 64);
    const source = published.sourceContext as { kind: string; mappings: Array<{ mappingId: string }> };
    assert.equal(source.kind, "STORE_CATEGORY_SELECTION");
    assert.deepEqual(source.mappings.map((mapping) => mapping.mappingId), [f.first.mappingId]);
    const catalogue = await new StoreCategoriesReadService(db(), environment).read(f.principal, "en_GB");
    assert.equal(catalogue.storeProfile.activeCategory?.id, f.first.id);
    assert.deepEqual(catalogue.storeProfile.activeMappingIds, [f.first.mappingId]);
    assert.equal(catalogue.storeProfile.pendingState, "NONE");

    const second = await service().select(f.principal, command(f, f.second, 1, []));
    assert.equal(second.activeCategoryId, f.second.id);
    assert.equal(second.pendingSelectionGeneration, 2);
    assert.notEqual(second.activePromptRevisionId, first.activePromptRevisionId);
    assert.deepEqual(second.activeMappingIds, []);
    const revisions = await db().commerceAgentPromptRevision.findMany({
      where: { prompt: { shopId: f.shopId } }, orderBy: { revisionNumber: "asc" },
    });
    assert.deepEqual(revisions.map((r) => r.revisionNumber), [1, 2]);
    assert.equal(await db().commerceAgentPrompt.count({ where: { shopId: f.shopId } }), 1);
    assert.equal(await db().commerceAgentConfiguration.count({ where: { shopId: f.shopId, environment } }), 1);
    const active = await db().commerceAgentConfiguration.findFirstOrThrow({ where: { shopId: f.shopId, environment } });
    assert.equal(active.activePromptRevisionId, second.activePromptRevisionId);
    assert.deepEqual(await protectedState(f), before);
  } finally {
    await cleanup(f);
  }
});

test("PostgreSQL generation-CAS prevents duplicate revisions and lost concurrent updates", {
  skip: !databaseUrl,
}, async () => {
  const f = await fixture();
  try {
    const first = await Promise.allSettled([
      service().select(f.principal, command(f, f.first, 0)),
      service().select(f.principal, command(f, f.second, 0)),
    ]);
    assert.equal(first.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(first.filter((result) => result.status === "rejected").length, 1);
    const profile = await db().commerceShopProfile.findUniqueOrThrow({ where: { shopId: f.shopId } });
    assert.equal(profile.pendingSelectionGeneration, 1);
    assert.equal(await db().commerceAgentPromptRevision.count({ where: { prompt: { shopId: f.shopId } } }), 1);
    const state = await db().commerceAgentConfiguration.findMany({ where: { shopId: f.shopId, environment } });
    assert.equal(state.length, 1);
    await assert.rejects(service().select(f.principal, command(f, f.first, 0)), StoreCategorySelectionError);
    assert.equal(await db().commerceAgentPromptRevision.count({ where: { prompt: { shopId: f.shopId } } }), 1);
  } finally {
    await cleanup(f);
  }
});

test("PostgreSQL failures reject stale credentials, inactive subscriptions, template drift, and foreign mappings without billing writes", {
  skip: !databaseUrl,
}, async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      service().select({ ...f.principal, credentialVersion: 2 }, command(f, f.first, 0)),
      StoreCategorySelectionError,
    );
    await assert.rejects(
      service().select(f.principal, command(f, f.first, 0, [f.second.mappingId])),
      StoreCategorySelectionError,
    );
    await db().subscription.update({ where: { shopId: f.shopId }, data: { status: "FROZEN" } });
    await assert.rejects(service().select(f.principal, command(f, f.first, 0)), StoreCategorySelectionError);
    await db().subscription.update({ where: { shopId: f.shopId }, data: { status: "ACTIVE" } });
    const before = await protectedState(f);
    // A version change between rendering and transaction entry must not publish stale text.
    const intercepted = {
      commercePromptTemplateCategory: db().commercePromptTemplateCategory,
      $transaction: async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number }) => {
        await db().commercePromptTemplate.update({
          where: { id: f.first.templateId }, data: { editVersion: { increment: 1 } },
        });
        return db().$transaction(callback, options);
      },
    };
    await assert.rejects(
      new StoreCategorySelectionService(intercepted as never, environment).select(f.principal, command(f, f.first, 0)),
      StoreCategorySelectionError,
    );
    assert.equal(await db().commerceShopProfile.count({ where: { shopId: f.shopId } }), 0);
    assert.equal(await db().commerceAgentPromptRevision.count({ where: { prompt: { shopId: f.shopId } } }), 0);
    assert.equal(await db().commerceAgentConfiguration.count({ where: { shopId: f.shopId } }), 0);
    assert.deepEqual(await protectedState(f), before);
  } finally {
    await cleanup(f);
  }
});

after(async () => { await prisma?.$disconnect(); });
