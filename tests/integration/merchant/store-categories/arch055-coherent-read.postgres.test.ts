import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CommerceEnvironment, Prisma, PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { StoreCategoriesReadService } from "../../../../src/merchant/store-categories/store-categories-read.service.js";
import { StoreCategorySelectionService } from "../../../../src/merchant/store-categories/store-category-selection.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
let prisma: PrismaClient | undefined;
const revisionHistorySelects: string[] = [];
const revisionUpdates: string[] = [];
const db = () => {
  if (!prisma) {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } }, log: [{ emit: "event", level: "query" }] });
    prisma.$on("query", (event) => {
      if (/^\s*SELECT/i.test(event.query) && event.query.includes('"CommerceAgentPromptRevision"')) {
        revisionHistorySelects.push(event.query);
      }
      if (/^\s*UPDATE/i.test(event.query) && event.query.includes('"CommerceAgentPromptRevision"')) {
        revisionUpdates.push(event.query);
      }
    });
  }
  return prisma;
};

test("ARCH-055 category GET returns a coherent pre-publication snapshot", { skip: !databaseUrl }, async () => {
  const suffix = randomUUID();
  const domain = `https://${suffix}.arch055-category.invalid`;
  let shopId: string | undefined;
  let adminId: string | undefined;
  const categoryIds: string[] = [];
  const templateIds: string[] = [];
  const mappingIds: string[] = [];
  let foreignPromptId: string | undefined;
  let foreignDraftId: string | undefined;
  let planId: string | undefined;
  let reachedProfileRead!: () => void;
  let releaseProfileRead!: () => void;
  const atProfileRead = new Promise<void>((resolve) => { reachedProfileRead = resolve; });
  const profileReadGate = new Promise<void>((resolve) => { releaseProfileRead = resolve; });
  try {
    const shop = await db().shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true } });
    shopId = shop.id;
    const installation = await db().wooCommerceInstallation.create({ data: {
      shopId, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32), credentialVersion: 1,
    } });
    const plan = await db().billingPlan.create({ data: {
      shopifyPlanHandle: `arch055-category-${suffix}`, name: "ARCH-055 category", kind: "FREE", active: true,
    } });
    planId = plan.id;
    await db().subscription.create({ data: { shopId, planId, status: "ACTIVE" } });
    await db().shopEntitlementCounter.create({ data: {
      shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 5, committedQuantity: 0, reservedQuantity: 0,
    } });
    const admin = await db().platformAdmin.create({ data: { email: `${suffix}@arch055-category.invalid` } });
    adminId = admin.id;
    const categories = [];
    for (const label of ["A", "B"]) {
      const category = await db().commercePromptTemplateCategory.create({ data: {
        slug: `${label.toLowerCase()}-${suffix}`, displayName: `Category ${label}`, enabled: false,
        createdByAdminId: admin.id, updatedByAdminId: admin.id,
      } });
      categoryIds.push(category.id);
      const template = await db().commercePromptTemplate.create({ data: {
        key: `${label.toLowerCase()}-${suffix}`, categoryId: category.id, displayName: `Template ${label}`,
        promptText: `Prompt ${label}`, createdByAdminId: admin.id, updatedByAdminId: admin.id,
      } });
      templateIds.push(template.id);
      await db().commercePromptTemplateCategory.update({ where: { id: category.id }, data: { enabled: true, defaultTemplateId: template.id } });
      const mapping = await db().commerceStoreCategoryTaxonomyMapping.create({ data: {
        categoryId: category.id, shopifyTaxonomyCategoryId: `${label}-${suffix}`, conditionKey: "category_key",
      } });
      mappingIds.push(mapping.id);
      categories.push({ id: category.id, mappingId: mapping.id });
    }
    const principal: WooInstallationPrincipal = {
      shopId, installationId: installation.id, canonicalSiteUrl: domain, credentialVersion: installation.credentialVersion,
    };
    const writer = new StoreCategorySelectionService(db(), CommerceEnvironment.TEST);
    const select = (index: number, generation: number) => writer.select(principal, {
      schemaVersion: 1, categoryId: categories[index]!.id, selectedMappingIds: [categories[index]!.mappingId],
      expectedPendingSelectionGeneration: generation,
    });
    const beforeFirstPublicationReads = revisionHistorySelects.length;
    const initial = await select(0, 0);
    assert.equal(revisionHistorySelects.length - beforeFirstPublicationReads, 0);
    assert.equal(initial.activeCategoryId, categories[0]!.id);
    const beforeExistingPublicationReads = revisionHistorySelects.length;
    const next = await select(1, 1);
    assert.equal(revisionHistorySelects.length - beforeExistingPublicationReads, 2);
    assert.equal(next.activeCategoryId, categories[1]!.id);

    const readDatabase = {
      $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { isolationLevel: Prisma.TransactionIsolationLevel }) =>
        db().$transaction((tx) => callback(new Proxy(tx, { get(target, property, receiver) {
          if (property === "commerceShopProfile") {
            return new Proxy(target.commerceShopProfile, { get(delegate, method, delegateReceiver) {
              if (method === "findUnique") return async (...args: Parameters<typeof delegate.findUnique>) => {
                reachedProfileRead();
                await profileReadGate;
                return delegate.findUnique(...args);
              };
              return Reflect.get(delegate, method, delegateReceiver);
            } });
          }
          return Reflect.get(target, property, receiver);
        } })) as Promise<unknown>, options),
    };
    const read = new StoreCategoriesReadService(readDatabase as never, CommerceEnvironment.TEST);
    const pendingRead = read.read(principal);
    await atProfileRead;
    releaseProfileRead();
    const raced = await pendingRead;
    assert.equal(raced.storeProfile.activeCategory?.id, categories[0]!.id);
    assert.deepEqual(raced.storeProfile.activeMappingIds, [categories[0]!.mappingId]);
    const after = await new StoreCategoriesReadService(db(), CommerceEnvironment.TEST).read(principal);
    assert.equal(after.storeProfile.activeCategory?.id, categories[1]!.id);
    assert.deepEqual(after.storeProfile.activeMappingIds, [categories[1]!.mappingId]);

    const activeConfiguration = await db().commerceAgentConfiguration.findFirstOrThrow({
      where: { shopId, environment: CommerceEnvironment.TEST, scope: "SHOP" },
    });
    const draft = await db().commerceAgentPromptRevision.create({ data: {
      promptId: activeConfiguration.activePromptRevisionId
        ? (await db().commerceAgentPromptRevision.findUniqueOrThrow({
          where: { id: activeConfiguration.activePromptRevisionId }, select: { promptId: true },
        })).promptId
        : "", revisionNumber: 3, status: "DRAFT", promptText: "pending draft",
    } });
    const profileBeforeDraft = await db().commerceShopProfile.findUniqueOrThrow({ where: { shopId } });
    await db().commerceShopProfile.update({ where: { shopId }, data: {
      pendingCategoryId: categories[0]!.id, pendingPromptRevisionId: draft.id, pendingSelectedAt: new Date(),
    } });
    const readsBeforeDraftPublish = revisionHistorySelects.length;
    const updatesBeforeDraftPublish = revisionUpdates.length;
    const draftPublished = await writer.select(principal, {
      schemaVersion: 1, categoryId: categories[0]!.id, selectedMappingIds: [categories[0]!.mappingId],
      expectedPendingSelectionGeneration: profileBeforeDraft.pendingSelectionGeneration,
    });
    assert.equal(draftPublished.activeCategoryId, categories[0]!.id);
    assert.equal(revisionHistorySelects.length, readsBeforeDraftPublish);
    assert.equal(revisionUpdates.length - updatesBeforeDraftPublish, 1);
    assert.equal((await db().commerceAgentPromptRevision.findUniqueOrThrow({ where: { id: draft.id } })).status, "PUBLISHED");

    await db().commerceShopProfile.update({ where: { shopId }, data: {
      pendingCategoryId: categories[1]!.id,
      pendingPromptRevisionId: activeConfiguration.activePromptRevisionId,
      pendingSelectedAt: new Date(),
    } });
    const invalidBefore = await db().commerceShopProfile.findUniqueOrThrow({ where: { shopId } });
    await assert.rejects(() => writer.select(principal, {
      schemaVersion: 1, categoryId: categories[1]!.id, selectedMappingIds: [categories[1]!.mappingId],
      expectedPendingSelectionGeneration: invalidBefore.pendingSelectionGeneration,
    }));
    const invalidAfter = await db().commerceShopProfile.findUniqueOrThrow({ where: { shopId } });
    assert.equal(invalidAfter.pendingPromptRevisionId, invalidBefore.pendingPromptRevisionId);
    assert.equal(invalidAfter.pendingSelectionGeneration, invalidBefore.pendingSelectionGeneration);

    const foreignPrompt = await db().commerceAgentPrompt.create({ data: { scope: "PLATFORM", shopId: null } });
    foreignPromptId = foreignPrompt.id;
    const foreignDraft = await db().commerceAgentPromptRevision.create({ data: {
      promptId: foreignPrompt.id, revisionNumber: 1, status: "DRAFT", promptText: "foreign draft",
    } });
    foreignDraftId = foreignDraft.id;
    await db().commerceShopProfile.update({ where: { shopId }, data: { pendingPromptRevisionId: foreignDraft.id } });
    const profileBeforeForeignDraft = await db().commerceShopProfile.findUniqueOrThrow({ where: { shopId } });
    await assert.rejects(() => writer.select(principal, {
      schemaVersion: 1, categoryId: categories[0]!.id, selectedMappingIds: [categories[0]!.mappingId],
      expectedPendingSelectionGeneration: profileBeforeForeignDraft.pendingSelectionGeneration,
    }));
    const profileAfterForeignDraft = await db().commerceShopProfile.findUniqueOrThrow({ where: { shopId } });
    assert.equal(profileAfterForeignDraft.pendingPromptRevisionId, foreignDraft.id);
    assert.equal((await db().commerceAgentPromptRevision.findUniqueOrThrow({ where: { id: foreignDraft.id } })).status, "DRAFT");
  } finally {
    releaseProfileRead?.();
    if (shopId) {
      await db().commerceAgentConfiguration.deleteMany({ where: { shopId } });
      await db().commerceShopProfile.deleteMany({ where: { shopId } });
      const prompts = await db().commerceAgentPrompt.findMany({ where: { shopId }, select: { id: true } });
      await db().commerceAgentPromptRevision.deleteMany({ where: { promptId: { in: prompts.map((row) => row.id) } } });
      await db().commerceAgentPrompt.deleteMany({ where: { shopId } });
      await db().shop.deleteMany({ where: { id: shopId } });
    }
    if (foreignDraftId) await db().commerceAgentPromptRevision.deleteMany({ where: { id: foreignDraftId } });
    if (foreignPromptId) await db().commerceAgentPrompt.deleteMany({ where: { id: foreignPromptId } });
    if (categoryIds.length) {
      await db().commercePromptTemplateCategory.updateMany({ where: { id: { in: categoryIds } }, data: { defaultTemplateId: null } });
      await db().commerceStoreCategoryTaxonomyMapping.deleteMany({ where: { id: { in: mappingIds } } });
      await db().commercePromptTemplate.deleteMany({ where: { id: { in: templateIds } } });
      await db().commercePromptTemplateCategory.deleteMany({ where: { id: { in: categoryIds } } });
    }
    if (adminId) await db().platformAdmin.deleteMany({ where: { id: adminId } });
    if (planId) await db().billingPlan.deleteMany({ where: { id: planId } });
  }
});

after(async () => { await prisma?.$disconnect(); });