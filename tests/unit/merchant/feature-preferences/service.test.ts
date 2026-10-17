import assert from "node:assert/strict";
import test from "node:test";
import { MerchantFeaturePreferencesService } from "../../../../src/merchant/feature-preferences/service.js";
import { FeaturePreferencesConflictError, FeaturePreferencesIntegrityError } from "../../../../src/merchant/feature-preferences/contract.js";

const principal = { shopId: "shop", canonicalSiteUrl: "https://woo.example", installationId: "installation", credentialVersion: 1 };
const timestamp = new Date("2026-10-16T00:00:00.000Z");
const optional = { id: "feature_optional", key: "optional", displayName: "Optional", description: null,
  active: true, activationMode: "MERCHANT_OPT_IN", systemRequired: false, updatedAt: timestamp };
const always = { ...optional, id: "feature_required", key: "required", displayName: "Required", activationMode: "ALWAYS_ENABLED", systemRequired: true };

function fixture(options: { platform?: string; installationStatus?: string; subscriptionStatus?: string; planActive?: boolean } = {}) {
  const preferences: Array<{ featureId: string; enabled: boolean; updatedAt: Date }> = [];
  const features = [optional, always];
  const mappings = features.map((feature) => ({ featureId: feature.id, enabled: true, feature }));
  let writes = 0;
  const tx = {
    $queryRaw: async (query: { strings: string[] }) => query.strings.join("").includes("WooCommerceInstallation")
      ? [{ ...principal, id: "installation", status: options.installationStatus ?? "ACTIVE", revokedAt: null }]
      : [{ id: "shop", domain: principal.canonicalSiteUrl, platform: options.platform ?? "WOOCOMMERCE",
        shopifyShopId: null, status: "ACTIVE" }],
    subscription: { findUnique: async () => ({ id: "subscription", shopId: "shop", status: options.subscriptionStatus ?? "ACTIVE", planId: "plan",
      plan: { id: "plan", active: options.planActive ?? true, updatedAt: timestamp, features: mappings } }) },
    feature: { findMany: async () => features },
    shopFeaturePreference: {
      findMany: async () => preferences.map((p) => ({ ...p })),
      upsert: async ({ create }: { create: { shopId: string; featureId: string; enabled: boolean } }) => {
        assert.equal(create.shopId, "shop");
        writes += 1;
        const index = preferences.findIndex((p) => p.featureId === create.featureId);
        const value = { featureId: create.featureId, enabled: create.enabled, updatedAt: new Date(timestamp.getTime() + writes * 1000) };
        if (index >= 0) preferences[index] = value; else preferences.push(value);
      },
    },
  };
  const db = { $transaction: async (run: (client: unknown) => Promise<unknown>) => run(tx) };
  return { service: new MerchantFeaturePreferencesService(db as never), getWrites: () => writes, mappings, features };
}

test("Shared-based projection shows required, effective, editable and plan eligibility", async () => {
  const { service, mappings } = fixture();
  const initial = await service.read(principal);
  assert.equal(initial.schemaVersion, 1);
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(initial.features.map((f) => [f.id, f.enabled, f.effective, f.editable, f.required, f.planEligible]), [
    [optional.id, false, false, true, false, true],
    [always.id, false, true, false, true, true],
  ]);
  mappings[0]!.enabled = false;
  const after = await service.read(principal);
  assert.equal(after.features[0]?.planEligible, false);
  assert.equal(after.features[0]?.editable, false);
  assert.notEqual(after.revision, initial.revision);
});

test("CAS rejects stale and denied changes without writes; identical current update is read-only", async () => {
  const { service, getWrites } = fixture();
  const initial = await service.read(principal);
  await assert.rejects(() => service.update(principal, { expectedRevision: initial.revision, changes: [{ featureId: always.id, enabled: true }] }),
    (error: unknown) => error instanceof FeaturePreferencesConflictError && error.code === "feature_preferences_denied");
  await assert.rejects(() => service.update(principal, { expectedRevision: initial.revision, changes: [{ featureId: "other_tenant", enabled: true }] }),
    FeaturePreferencesConflictError);
  assert.equal(getWrites(), 0);
  const saved = await service.update(principal, { expectedRevision: initial.revision, changes: [{ featureId: optional.id, enabled: true }] });
  assert.notEqual(saved.revision, initial.revision);
  assert.equal(saved.features[0]?.effective, true);
  assert.equal(getWrites(), 1);
  assert.equal((await service.update(principal, { expectedRevision: saved.revision, changes: [{ featureId: optional.id, enabled: true }] })).revision, saved.revision);
  assert.equal(getWrites(), 1);
  await assert.rejects(() => service.update(principal, { expectedRevision: initial.revision, changes: [] }),
    (error: unknown) => error instanceof FeaturePreferencesConflictError && error.code === "feature_preferences_conflict");
});

test("invalid shop, installation and inactive plan fail before merchant writes", async () => {
  for (const option of [{ platform: "SHOPIFY" }, { installationStatus: "REVOKED" }, { subscriptionStatus: "FROZEN" }, { planActive: false }]) {
    const t = fixture(option);
    const error = "platform" in option || "installationStatus" in option ? FeaturePreferencesIntegrityError : FeaturePreferencesConflictError;
    await assert.rejects(() => t.service.read(principal), error);
    assert.equal(t.getWrites(), 0);
  }
});
