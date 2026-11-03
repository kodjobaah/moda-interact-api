import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CommerceEnvironment, Prisma, PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { StoreCategoriesReadService } from "../../../../src/merchant/store-categories/store-categories-read.service.js";
import { StoreCategorySelectionService } from "../../../../src/merchant/store-categories/store-category-selection.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
type QueryEventClient = { $on(event: "query", listener: (event: { query: string }) => void): void };
type CategoryFixture = { id: string; mappingId: string };
let prisma: PrismaClient | undefined;
let readerClient: PrismaClient | undefined;
const revisionHistorySelects: string[] = [];
const revisionUpdates: string[] = [];
const db = () => {
  if (!prisma) {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } }, log: [{ emit: "event", level: "query" }] });
    (prisma as unknown as QueryEventClient).$on("query", (event) => {
      if (/^\s*SELECT/i.test(event.query) && event.query.includes('"CommerceAgentPromptRevision"') &&
        (event.query.includes('"status"') || event.query.includes('"revisionNumber"'))) {
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
  const categoryIds: string[] = [];
  const templateIds: string[] = [];
  const mappingIds: string[] = [];
  let planId: string | undefined;
  let reachedProfileRead!: () => void;
  let releaseProfileRead!: () => void;
  let pendingRead: ReturnType<StoreCategoriesReadService["read"]> | undefined;
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
    const categories: CategoryFixture[] = [];
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

    readerClient = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const readDatabase = {
      $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { isolationLevel: Prisma.TransactionIsolationLevel }) =>
        readerClient!.$transaction((tx) => callback(new Proxy(tx, { get(target, property, receiver) {
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
        } })) as Promise<unknown>, { ...options, timeout: 30_000 }),
    };
    const read = new StoreCategoriesReadService(readDatabase as never, CommerceEnvironment.TEST);
    pendingRead = read.read(principal);
    await atProfileRead;
    const next = await select(1, 1);
    assert.equal(revisionHistorySelects.length - beforeExistingPublicationReads, 2);
    assert.equal(next.activeCategoryId, categories[1]!.id);
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
    const foreignDraft = await db().commerceAgentPromptRevision.create({ data: {
      promptId: foreignPrompt.id, revisionNumber: 1, status: "DRAFT", promptText: "foreign draft",
    } });
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
    await pendingRead?.catch(() => undefined);
    // Prompt revisions are immutable; the canonical runner drops this isolated database after the suite.
  }
});

after(async () => { await Promise.all([prisma?.$disconnect(), readerClient?.$disconnect()]); });
// Opt-in paired evidence uses the same harness/fixtures against either source root.
// Immutable publication evidence is never deleted: each restored sample gets an
// independent, deterministically named tenant with exactly the same starting state.
test("ARCH-055 M04/M05 restored-fixture paired evidence", {
  skip: !databaseUrl || !process.env.ARCH055_MEASURE,
}, async () => {
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const root = process.env.ARCH055_SOURCE_ROOT ?? process.cwd();
  const load = (path: string) => import(pathToFileURL(resolve(root, "src/merchant", path)).href);
  const [{ StoreCategorySelectionService: Category }, { MerchantFeaturePreferencesService: Features },
    { MerchantRecoveryPolicyService: Policy }, { MerchantAiResponseDelayService: Delay },
    { MerchantRecoverySummaryService: Summary }] = await Promise.all([
    load("store-categories/store-category-selection.service.ts"), load("feature-preferences/service.ts"),
    load("recovery-policy/service.ts"), load("ai-response-delay/service.ts"),
    load("recovery-summary/recovery-summary.service.ts"),
  ]);
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl! } }, log: [{ emit: "event", level: "query" }] });
  const clock = new Date("2026-11-02T12:00:00.000Z");
  type Call = { method: string; returnedRows: number | null; affectedRows: number | null; selection: unknown };
  let calls: Call[] | undefined;
  let sql: string[] | undefined;
  let transactions: number[] | undefined;
  (client as unknown as QueryEventClient).$on("query", (e) => sql?.push(e.query.replace(/\s+/g, " ").trim()));
  // Test-local observation only; methods and transaction options pass through.
  function observe(target: object, prefix = ""): object {
    return new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key);
      if (key === "$transaction") return async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => {
        const start = performance.now();
        try { return await client.$transaction((tx) => callback(observe(tx) as Prisma.TransactionClient), options); }
        finally { transactions?.push(performance.now() - start); }
      };
      if (typeof value === "function") return async (...args: unknown[]) => {
        const result: unknown = await value.apply(object, args);
        const method = prefix + String(key);
        const write = /\.(create|update|upsert|delete)/.test(method);
        calls?.push({
          method, returnedRows: Array.isArray(result) ? result.length : result === null ? 0 :
            typeof result === "object" ? 1 : null,
          affectedRows: write ? typeof result === "object" && result !== null && "count" in result
            ? Number(result.count) : result === null ? 0 : 1 : 0,
          selection: typeof args[0] === "object" && args[0] !== null && "select" in args[0] ? args[0].select : null,
        });
        return result;
      };
      if (value && typeof value === "object" && !String(key).startsWith("_")) return observe(value, String(key) + ".");
      return value;
    } });
  }
  const port = observe(client) as PrismaClient;
  const shapes = new Map<string, number>();
  const shapeId = (shape: string) => {
    if (!shapes.has(shape)) shapes.set(shape, shapes.size + 1);
    return shapes.get(shape)!;
  };
  const records: object[] = [];
  const admin = await client.platformAdmin.create({ data: { id: "arch055-measure-admin", email: "measure@arch055.invalid" } });
  const category = await client.commercePromptTemplateCategory.create({ data: {
    id: "arch055-measure-category", slug: "arch055-measure-category", displayName: "Measurement", enabled: false,
    createdByAdminId: admin.id, updatedByAdminId: admin.id,
  } });
  const template = await client.commercePromptTemplate.create({ data: {
    id: "arch055-measure-template", key: "arch055-measure-template", categoryId: category.id,
    displayName: "Measurement", promptText: "Fixed measurement prompt.",
    createdByAdminId: admin.id, updatedByAdminId: admin.id,
  } });
  await client.commercePromptTemplateCategory.update({ where: { id: category.id }, data: { enabled: true, defaultTemplateId: template.id } });
  const mapping = await client.commerceStoreCategoryTaxonomyMapping.create({ data: {
    id: "arch055-measure-mapping", categoryId: category.id, shopifyTaxonomyCategoryId: "measurement", conditionKey: "measurement",
  } });
  const plan = await client.billingPlan.create({ data: {
    id: "arch055-measure-plan", shopifyPlanHandle: "arch055-measure-plan", name: "Measurement", kind: "FREE", active: true, updatedAt: clock,
  } });
  const features: Awaited<ReturnType<typeof client.feature.create>>[] = [];
  for (let i = 0; i < 4; i++) {
    const feature = await client.feature.create({ data: {
      id: `arch055-measure-feature-${i}`, key: `arch055-measure-feature-${i}`, displayName: `Measure ${i}`,
      active: true, activationMode: i === 2 ? "ALWAYS_ENABLED" : "MERCHANT_OPT_IN", systemRequired: i === 3, updatedAt: clock,
    } });
    features.push(feature);
    await client.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id, enabled: true } });
  }
  const profiles = ["M04-new", "M04-empty", "M04-draft", "M05-get", "M05-change", "M05-noop",
    "M05-policy", "M05-delay", "M05-summary-absent", "M05-summary-active", "M05-summary-expired"];
  try {
    for (const profile of profiles) for (let sample = -2; sample < 5; sample++) {
      const id = `arch055-${profile.toLowerCase()}-${sample + 2}`;
      const domain = `https://${id}.invalid`;
      await client.shop.create({ data: { id, domain, platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true } });
      const installation = await client.wooCommerceInstallation.create({ data: {
        id: id + "-installation", shopId: id, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32), credentialVersion: 1,
      } });
      const principal: WooInstallationPrincipal = { shopId: id, installationId: installation.id, canonicalSiteUrl: domain, credentialVersion: 1 };
      await client.subscription.create({ data: { id: id + "-subscription", shopId: id, planId: plan.id, status: "ACTIVE" } });
      await client.shopEntitlementCounter.create({ data: {
        shopId: id, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 5, committedQuantity: 0, reservedQuantity: 0,
      } });
      if (profile.startsWith("M04") && profile !== "M04-new") {
        const prompt = await client.commerceAgentPrompt.create({ data: { id: id + "-prompt", scope: "SHOP", shopId: id } });
        if (profile === "M04-draft") {
          const draft = await client.commerceAgentPromptRevision.create({ data: {
            id: id + "-draft", promptId: prompt.id, revisionNumber: 1, status: "DRAFT", promptText: "Draft",
          } });
          await client.commerceShopProfile.create({ data: {
            shopId: id, pendingCategoryId: category.id, pendingPromptRevisionId: draft.id, pendingSelectedAt: clock,
          } });
        }
      }
      if (profile.startsWith("M05")) {
        await client.shopFeaturePreference.createMany({ data: features.slice(0, 2).map((feature, i) => ({
          id: id + "-preference-" + i, shopId: id, featureId: feature.id, enabled: false, updatedAt: clock,
        })) });
        if (profile !== "M05-summary-absent") await client.shopSettings.create({ data: {
          shopId: id, onboardingCompleted: true, recoveryDelayMinutes: 45, recoveryOfferMode: "NONE",
          followUpEnabled: false, followUpDelayMinutes: null, aiResponseDelayMinutes: 1, updatedAt: clock,
        } });
        if (["M05-policy", "M05-delay", "M05-summary-active", "M05-summary-expired"].includes(profile)) {
          await client.shopRecoveryPolicyOverride.create({ data: {
            shopId: id, reason: "Measurement", updatedByPlatformAdminId: admin.id,
            recoveryDelayMinutes: 90, recoveryOfferMode: "NONE", followUpEnabled: false,
            expiresAt: new Date(profile.endsWith("expired") ? "2026-11-01T12:00:00Z" : "2026-11-04T12:00:00Z"),
          } });
        }
      }
      const featureService = new Features(port);
      const initial = profile === "M05-change" || profile === "M05-noop" ? await new Features(client).read(principal) : undefined;
      const before = await client.shopFeaturePreference.findMany({ where: { shopId: id }, orderBy: { featureId: "asc" } });
      const timings: Record<string, number>[] = [];
      calls = []; sql = []; transactions = [];
      const started = performance.now();
      let result;
      if (profile.startsWith("M04")) result = await new Category(port, CommerceEnvironment.TEST, () => clock).select(principal, {
          schemaVersion: 1, categoryId: category.id, selectedMappingIds: [mapping.id], expectedPendingSelectionGeneration: 0,
        });
        else if (profile === "M05-get") result = await featureService.read(principal, (t: Record<string, number>) => timings.push(t));
        else if (initial) result = await featureService.update(principal, {
          expectedRevision: initial.revision, changes: [{ featureId: features[0]!.id, enabled: profile === "M05-change" }],
        }, (t: Record<string, number>) => timings.push(t));
        else if (profile === "M05-policy") result = await new Policy(port, () => clock).read(principal);
        else if (profile === "M05-delay") result = await new Delay(port, () => clock).read(principal);
        else result = await new Summary(port).read(principal, clock);
      // Stop before postconditions/fixture inspection.
      const elapsedMs = performance.now() - started;
      const observedCalls = calls; const observedSql = sql; const transactionMs = transactions;
      calls = undefined; sql = undefined; transactions = undefined;
      const afterRows = await client.shopFeaturePreference.findMany({ where: { shopId: id }, orderBy: { featureId: "asc" } });
      let affectedTargetRows = afterRows.filter((row, i) => row.enabled !== before[i]?.enabled || row.updatedAt.getTime() !== before[i]?.updatedAt.getTime()).length;
      if (profile.startsWith("M04")) {
        assert.equal(result.activeCategoryId, category.id);
        const revision = await client.commerceAgentPromptRevision.findFirstOrThrow({ where: { prompt: { shopId: id } } });
        assert.equal(revision.status, "PUBLISHED"); assert.equal(revision.revisionNumber, 1);
        assert.equal(revision.sourceTemplateId, template.id);
        affectedTargetRows = 1;
        const history = observedCalls.filter((c) => c.method === "commerceAgentPromptRevision.findFirst");
        assert.equal(history.length, profile === "M04-empty" ? 2 : 0);
        if (profile === "M04-draft") assert.equal(observedCalls.find((c) => c.method === "commerceAgentPromptRevision.updateMany")?.affectedRows, 1);
      } else if (profile === "M05-change") {
        assert.equal(affectedTargetRows, 1); assert.notEqual(result.revision, initial!.revision);
        assert.equal(result.revision, (await new Features(client).read(principal)).revision);
        assert.equal(afterRows[0]!.enabled, true);
        for (const phase of ["initial", "final"]) for (const name of ["subscriptionLookupMs", "featuresLookupMs", "preferencesLookupMs", "projectionMs"])
          assert.ok(Number.isFinite(timings[0]?.[`${phase}.${name}`]));
      } else if (profile === "M05-noop") {
        assert.deepEqual(afterRows, before); assert.equal(result.revision, initial!.revision);
        assert.equal(Object.keys(timings[0]!).some((k) => k.startsWith("final.")), false);
      } else if (profile === "M05-policy") {
        assert.equal(result.effective.recoveryDelayMinutes, 90); assert.equal(result.source, "ADMIN_OVERRIDE");
      } else if (profile === "M05-delay") assert.equal(result.aiResponseDelayMinutes, 1);
      else if (profile.startsWith("M05-summary")) {
        assert.equal(result.recoveryDelayMinutes, profile.endsWith("absent") ? 30 : profile.endsWith("active") ? 90 : 45);
        assert.equal(observedSql.length, 1);
      } else {
        for (const feature of features) assert.ok(result.features.some((f: { id: string }) => f.id === feature.id));
        assert.equal(result.features.find((f: { id: string }) => f.id === features[2]!.id).required, true);
        assert.equal(result.features.find((f: { id: string }) => f.id === features[3]!.id).required, true);
      }
      if (!profile.startsWith("M04")) assert.equal(await client.shopSettings.count({ where: { shopId: id } }), profile.endsWith("absent") ? 0 : 1);
      if (sample >= 0) records.push({
        profile, sample: sample + 1, fixture: id, elapsedMs, transactionMs, logicalCalls: observedCalls.length,
        calls: observedCalls, sql: observedSql.map(shapeId), affectedTargetRows, timings,
        retries: observedSql.filter((s) => s === "ROLLBACK").length,
        externalPorts: "none configured by these database-only services", wireBytes: "not measured", triggerWork: "not measured",
      });
    }
    process.stdout.write("ARCH055_MEASURE " + JSON.stringify({
      version: process.env.ARCH055_MEASURE, sourceRoot: root, records,
      shapes: Object.fromEntries([...shapes].map(([shape, id]) => [id, shape])),
    }) + "\n");
  } finally { await client.$disconnect(); }
});
