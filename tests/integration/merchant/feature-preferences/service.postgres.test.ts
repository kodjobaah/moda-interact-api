import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test from "node:test";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { MerchantFeaturePreferencesService } from "../../../../src/merchant/feature-preferences/service.js";
import { FeaturePreferencesConflictError, FeaturePreferencesIntegrityError } from "../../../../src/merchant/feature-preferences/contract.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

/** Run exclusively on a migration-current disposable Postgres container via the registered runner. */
test("Woo feature preferences: entitlement, CAS, races, tenant isolation, revocation and plan drift", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = randomUUID();
  const handle = `api014_${suffix}`;
  const ids: string[] = [];
  const shopIds: string[] = [];
  let planId: string | undefined;
  try {
    const plan = await db.billingPlan.create({ data: { shopifyPlanHandle: handle, name: "API-014", kind: "FREE" } });
    planId = plan.id;
    const [opt, opt2, always, required, forbidden] = await Promise.all([
      db.feature.create({ data: { key: `api014-opt-${suffix}`, displayName: "Optional A", activationMode: "MERCHANT_OPT_IN" } }),
      db.feature.create({ data: { key: `api014-opt2-${suffix}`, displayName: "Optional B", activationMode: "MERCHANT_OPT_IN" } }),
      db.feature.create({ data: { key: `api014-always-${suffix}`, displayName: "Always", activationMode: "ALWAYS_ENABLED" } }),
      db.feature.create({ data: { key: `api014-required-${suffix}`, displayName: "Required", activationMode: "MERCHANT_OPT_IN", systemRequired: true } }),
      db.feature.create({ data: { key: `api014-forbidden-${suffix}`, displayName: "Other Plan", activationMode: "MERCHANT_OPT_IN" } }),
    ]);
    ids.push(opt.id, opt2.id, always.id, required.id, forbidden.id);
    await db.billingPlanFeature.createMany({ data: [
      { planId, featureId: opt.id, enabled: true }, { planId, featureId: opt2.id, enabled: true },
      { planId, featureId: always.id, enabled: true }, { planId, featureId: required.id, enabled: true },
      { planId, featureId: forbidden.id, enabled: false },
    ] });
    const first = await db.shop.create({ data: { domain: `https://${suffix}-one.invalid`, platform: "WOOCOMMERCE" } });
    const second = await db.shop.create({ data: { domain: `https://${suffix}-two.invalid`, platform: "WOOCOMMERCE" } });
    shopIds.push(first.id, second.id);
    await db.subscription.createMany({ data: [
      { shopId: first.id, planId, status: "ACTIVE" }, { shopId: second.id, planId, status: "ACTIVE" },
    ] });
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: first.id, canonicalSiteUrl: first.domain, credentialDigest: Buffer.alloc(32),
    } });
    const principal: WooInstallationPrincipal = {
      shopId: first.id, canonicalSiteUrl: first.domain, installationId: installation.id,
      credentialVersion: installation.credentialVersion,
    };
    const service = new MerchantFeaturePreferencesService(db);
    const initial = await service.read(principal);
    const get = (id: string, response = initial) => response.features.find((f) => f.id === id)!;
    assert.deepEqual([get(opt.id).editable, get(opt.id).planEligible, get(opt.id).effective], [true, true, false]);
    assert.deepEqual([get(always.id).required, get(always.id).editable, get(always.id).effective], [true, false, true]);
    assert.deepEqual([get(required.id).required, get(required.id).editable], [true, false]);
    assert.deepEqual([get(forbidden.id).planEligible, get(forbidden.id).effective, get(forbidden.id).editable], [false, false, false]);
    for (const featureId of [always.id, required.id, forbidden.id, second.id]) {
      await assert.rejects(() => service.update(principal, {
        expectedRevision: initial.revision, changes: [{ featureId, enabled: true }],
      }), (error: unknown) => error instanceof FeaturePreferencesConflictError && error.code === "feature_preferences_denied");
    }
    assert.equal(await db.shopFeaturePreference.count({ where: { shopId: first.id } }), 0);
    const saved = await service.update(principal, {
      expectedRevision: initial.revision, changes: [{ featureId: opt.id, enabled: true }],
    });
    assert.notEqual(saved.revision, initial.revision);
    assert.equal(get(opt.id, saved).effective, true);
    const noop = await service.update(principal, {
      expectedRevision: saved.revision, changes: [{ featureId: opt.id, enabled: true }],
    });
    assert.equal(noop.revision, saved.revision);
    await assert.rejects(() => service.update(principal, { expectedRevision: initial.revision, changes: [] }),
      (error: unknown) => error instanceof FeaturePreferencesConflictError && error.code === "feature_preferences_conflict");
    const [one, two] = await Promise.allSettled([
      service.update(principal, { expectedRevision: saved.revision, changes: [{ featureId: opt2.id, enabled: true }] }),
      service.update(principal, { expectedRevision: saved.revision, changes: [{ featureId: opt.id, enabled: false }] }),
    ]);
    assert.equal([one, two].filter((x) => x.status === "fulfilled").length, 1);
    const loser = [one, two].find((x) => x.status === "rejected");
    assert.ok(loser?.status === "rejected" && loser.reason instanceof FeaturePreferencesConflictError);
    const afterRace = await service.read(principal);
    assert.equal((await db.shopFeaturePreference.count({ where: { shopId: second.id } })), 0);
    await db.billingPlanFeature.update({ where: { planId_featureId: { planId, featureId: forbidden.id } }, data: { enabled: true } });
    const changedEntitlement = await service.read(principal);
    assert.notEqual(changedEntitlement.revision, afterRace.revision);
    assert.equal(get(forbidden.id, changedEntitlement).editable, true);
    await assert.rejects(() => service.update(principal, { expectedRevision: afterRace.revision, changes: [] }), FeaturePreferencesConflictError);
    await db.feature.update({ where: { id: opt.id }, data: { displayName: "Optional A renamed" } });
    assert.notEqual((await service.read(principal)).revision, changedEntitlement.revision);
    await db.subscription.update({ where: { shopId: first.id }, data: { status: "FROZEN" } });
    await assert.rejects(() => service.read(principal), FeaturePreferencesConflictError);
    await db.subscription.update({ where: { shopId: first.id }, data: { status: "ACTIVE" } });
    await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { credentialVersion: { increment: 1 } } });
    await assert.rejects(() => service.read(principal), FeaturePreferencesIntegrityError);
    await assert.rejects(() => service.update(principal, { expectedRevision: saved.revision, changes: [] }), FeaturePreferencesIntegrityError);
    await assert.rejects(() => service.read({ ...principal, shopId: second.id }), FeaturePreferencesIntegrityError);
  } finally {
    if (shopIds.length) await db.shop.deleteMany({ where: { id: { in: shopIds } } });
    if (planId) await db.billingPlan.delete({ where: { id: planId } });
    if (ids.length) await db.feature.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
});
