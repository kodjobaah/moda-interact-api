import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMerchantFeaturePreferencesRoute } from "../../../../src/merchant/feature-preferences/routes.js";
import { Prisma, PrismaClient } from "@prisma/client";
import test from "node:test";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { FeaturePreferencesConflictError, MERCHANT_FEATURE_PREFERENCES_PATH } from "../../../../src/merchant/feature-preferences/contract.js";
import { MerchantFeaturePreferencesService } from "../../../../src/merchant/feature-preferences/service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
type QueryEventClient = { $on(event: "query", listener: (event: { query: string }) => void): void };

// Exercise the real HTTP mapping with the exact service result/error from each race.
async function assertHttpOutcome(principal: WooInstallationPrincipal, outcome: unknown, status: number, code?: string) {
  let actualStatus = 0; let body = "";
  const route = createMerchantFeaturePreferencesRoute({
    authenticator: { authenticate: async () => principal } as never,
    service: { update: async () => { if (outcome instanceof Error) throw outcome; return outcome; } } as never,
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({
    expectedRevision: "a".repeat(64), changes: [],
  }))]), { method: "PUT", url: MERCHANT_FEATURE_PREFERENCES_PATH, rawHeaders: ["Content-Type", "application/json"] }) as IncomingMessage;
  const response = { destroyed: false, headersSent: false,
    writeHead(value: number) { actualStatus = value; }, end(value: string) { body = value; },
  } as unknown as ServerResponse;
  assert.equal(await route.handle(request, response), true);
  assert.equal(actualStatus, status);
  assert.deepEqual(JSON.parse(body), code ? { error: code } : outcome);
}

test("ARCH-055 C03 Admin mapping interleavings and revision/no-op controls", { skip: !databaseUrl }, async () => {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } }, log: [{ emit: "event", level: "query" }] });
  const admin = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  const suffix = randomUUID();
  const domain = `https://${suffix}.arch055-feature.invalid`;
  let shopId: string | undefined;
  let planId: string | undefined;
  let featureId: string | undefined;
  let preferenceId: string | undefined;
  const createdFeatureIds: string[] = [];
  const preferenceUpserts: string[] = [];
  (db as unknown as QueryEventClient).$on("query", (event) => {
    if (/^\s*INSERT\s+INTO/i.test(event.query) && event.query.includes('"ShopFeaturePreference"')) {
      preferenceUpserts.push(event.query);
    }
  });
  let releaseUpsert = () => {};
  try {
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `arch055-feature-${suffix}`, name: "ARCH-055 feature", kind: "FREE", active: true,
    } });
    planId = plan.id;
    const feature = await db.feature.create({ data: {
      key: `arch055-feature-${suffix}`, displayName: "ARCH-055 optional", active: true,
      activationMode: "MERCHANT_OPT_IN", systemRequired: false,
    } });
    featureId = feature.id;
    const targetFeatureId = feature.id;
    const shop = await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE" } });
    shopId = shop.id;
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32), credentialVersion: 1,
    } });
    const principal: WooInstallationPrincipal = {
      shopId, installationId: installation.id, canonicalSiteUrl: domain, credentialVersion: installation.credentialVersion,
    };
    await db.subscription.create({ data: { shopId, planId, status: "ACTIVE" } });
    await db.billingPlanFeature.create({ data: { planId, featureId, enabled: true } });
    const seededPreference = await db.shopFeaturePreference.create({ data: { shopId, featureId, enabled: false } });
    preferenceId = seededPreference.id;
    const service = new MerchantFeaturePreferencesService(db);

    let upsertReached!: () => void;
    const atUpsert = new Promise<void>((resolve) => { upsertReached = resolve; });
    const upsertGate = new Promise<void>((resolve) => { releaseUpsert = resolve; });
    const wrappedDatabase = {
      $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { isolationLevel?: Prisma.TransactionIsolationLevel }) =>
        db.$transaction((tx) => callback(new Proxy(tx, { get(target, property, receiver) {
          if (property === "shopFeaturePreference") return new Proxy(target.shopFeaturePreference, {
            get(delegate, method, delegateReceiver) {
              if (method === "upsert") return async (args: Parameters<typeof delegate.upsert>[0]) => {
                upsertReached();
                await upsertGate;
                return delegate.upsert(args);
              };
              return Reflect.get(delegate, method, delegateReceiver);
            },
          });
          return Reflect.get(target, property, receiver);
        } })) as Promise<unknown>, options),
    };
    const interleavedService = new MerchantFeaturePreferencesService(wrappedDatabase as never);
    const initial = await service.read(principal);
    const timings: Readonly<Record<string, number>>[] = [];
    const beforeInterleavingSql = preferenceUpserts.length;
    const updatePromise = interleavedService.update(principal,
      { expectedRevision: initial.revision, changes: [{ featureId, enabled: true }] },
      (value) => timings.push(value));
    await atUpsert;
    await admin.billingPlanFeature.update({ where: { planId_featureId: { planId, featureId } }, data: { enabled: false } });
    releaseUpsert();
    const saved = await updatePromise;
    await assertHttpOutcome(principal, saved, 200);
    assert.equal(preferenceUpserts.length - beforeInterleavingSql, 1);
    const stored = await db.shopFeaturePreference.findUniqueOrThrow({ where: { id: preferenceId } });
    const mapping = await db.billingPlanFeature.findUniqueOrThrow({ where: { planId_featureId: { planId, featureId } } });
    assert.equal(stored.enabled, true);
    assert.equal(mapping.enabled, false);
    assert.deepEqual(saved.features.find((item) => item.id === featureId), {
      id: featureId, key: feature.key, name: feature.displayName, description: null,
      enabled: true, planEligible: false, effective: false, editable: false, required: false,
    });
    assert.notEqual(saved.revision, initial.revision);
    assert.equal((await service.read(principal)).revision, saved.revision);
    assert.equal(timings.length, 1);
    for (const phase of ["initial", "final"]) for (const name of [
      "subscriptionLookupMs", "featuresLookupMs", "preferencesLookupMs", "projectionMs",
    ]) assert.ok(Number.isFinite(timings[0]?.[`${phase}.${name}`]) && (timings[0]?.[`${phase}.${name}`] ?? -1) >= 0);

    await admin.billingPlanFeature.update({ where: { planId_featureId: { planId, featureId } }, data: { enabled: true } });
    await db.shopFeaturePreference.update({ where: { id: preferenceId }, data: { enabled: false } });
    const beforeAdminDisable = await service.read(principal);
    await admin.billingPlanFeature.update({ where: { planId_featureId: { planId, featureId } }, data: { enabled: false } });
    const unchangedAt = (await db.shopFeaturePreference.findUniqueOrThrow({ where: { id: preferenceId } })).updatedAt;
    const beforeStaleSql = preferenceUpserts.length;
    let observedError: unknown;
    await assert.rejects(() => service.update(principal,
      { expectedRevision: beforeAdminDisable.revision, changes: [{ featureId: targetFeatureId, enabled: true }] },
    ), (error: unknown) => { observedError = error; return error instanceof FeaturePreferencesConflictError && error.code === "feature_preferences_conflict"; });
    await assertHttpOutcome(principal, observedError, 409, "feature_preferences_conflict");
    assert.equal(preferenceUpserts.length, beforeStaleSql);
    assert.equal((await db.shopFeaturePreference.findUniqueOrThrow({ where: { id: preferenceId } })).updatedAt.getTime(), unchangedAt.getTime());
    const disabledRevision = await service.read(principal);
    const beforeDeniedSql = preferenceUpserts.length;
    await assert.rejects(() => service.update(principal,
      { expectedRevision: disabledRevision.revision, changes: [{ featureId: targetFeatureId, enabled: true }] },
    ), (error: unknown) => { observedError = error; return error instanceof FeaturePreferencesConflictError && error.code === "feature_preferences_denied"; });
    await assertHttpOutcome(principal, observedError, 409, "feature_preferences_denied");
    assert.equal(preferenceUpserts.length, beforeDeniedSql);
    assert.equal((await db.shopFeaturePreference.findUniqueOrThrow({ where: { id: preferenceId } })).updatedAt.getTime(), unchangedAt.getTime());

    await admin.billingPlanFeature.update({ where: { planId_featureId: { planId, featureId } }, data: { enabled: true } });
    await db.shopFeaturePreference.update({ where: { id: preferenceId }, data: { enabled: false } });
    const noOpRevision = await service.read(principal);
    const noOpTimings: Readonly<Record<string, number>>[] = [];
    const beforeNoOpSql = preferenceUpserts.length;
    const noOp = await service.update(principal,
      { expectedRevision: noOpRevision.revision, changes: [{ featureId, enabled: false }] },
      (value) => noOpTimings.push(value));
    await assertHttpOutcome(principal, noOp, 200);
    assert.equal(noOp.revision, noOpRevision.revision);
    assert.equal(preferenceUpserts.length, beforeNoOpSql);
    assert.equal(Object.keys(noOpTimings[0] ?? {}).some((key) => key.startsWith("final.")), false);
    const changed = await service.update(principal,
      { expectedRevision: noOp.revision, changes: [{ featureId, enabled: true }] });
    const afterChangedAt = (await db.shopFeaturePreference.findUniqueOrThrow({ where: { id: preferenceId } })).updatedAt;
    await assert.rejects(() => service.update(principal,
      { expectedRevision: noOp.revision, changes: [] },
    ), (error: unknown) => { observedError = error; return error instanceof FeaturePreferencesConflictError && error.code === "feature_preferences_conflict"; });
    await assertHttpOutcome(principal, observedError, 409, "feature_preferences_conflict");
    assert.equal((await db.shopFeaturePreference.findUniqueOrThrow({ where: { id: preferenceId } })).updatedAt.getTime(), afterChangedAt.getTime());
    assert.notEqual(changed.revision, noOp.revision);

    const bulkFeatures = await Promise.all(Array.from({ length: 20 }, (_, index) => db.feature.create({ data: {
      key: `arch055-bulk-${index}-${suffix}`, displayName: `ARCH-055 bulk ${index}`,
      active: true, activationMode: "MERCHANT_OPT_IN", systemRequired: false,
    } })));
    createdFeatureIds.push(...bulkFeatures.map((item) => item.id));
    await db.billingPlanFeature.createMany({ data: bulkFeatures.map((item) => ({ planId: planId!, featureId: item.id, enabled: true })) });
    const beforeRows = await db.shopFeaturePreference.count({ where: { shopId } });
    const beforeBulkSql = preferenceUpserts.length;
    const beforeBulkRevision = await service.read(principal);
    const bulkResult = await service.update(principal, {
      expectedRevision: beforeBulkRevision.revision,
      changes: bulkFeatures.map((item) => ({ featureId: item.id, enabled: true })),
    });
    const afterRows = await db.shopFeaturePreference.count({ where: { shopId } });
    assert.equal(preferenceUpserts.length - beforeBulkSql, bulkFeatures.length);
    assert.equal(afterRows - beforeRows, bulkFeatures.length);
    assert.notEqual(bulkResult.revision, beforeBulkRevision.revision);
  } finally {
    releaseUpsert?.();
    if (shopId) await db.shop.deleteMany({ where: { id: shopId } });
    if (planId) await db.billingPlan.deleteMany({ where: { id: planId } });
    if (createdFeatureIds.length) await db.feature.deleteMany({ where: { id: { in: createdFeatureIds } } });
    if (featureId) await db.feature.deleteMany({ where: { id: featureId } });
    await admin.$disconnect();
    await db.$disconnect();
  }
});