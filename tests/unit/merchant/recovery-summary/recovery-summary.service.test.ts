import assert from "node:assert/strict";
import test from "node:test";
import { MerchantRecoverySummaryService, RecoverySummaryIntegrityError } from "../../../../src/merchant/recovery-summary/recovery-summary.service.js";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";

const principal: WooInstallationPrincipal = {
  installationId: "install_1", shopId: "shop_1", canonicalSiteUrl: "https://woo.example",
  credentialVersion: 2,
};

function mockDb(overrides: { settings?: unknown; override?: unknown; shop?: unknown; installation?: unknown } = {}) {
  let queries = 0;
  const shop = overrides.shop === undefined
    ? { id: principal.shopId, domain: principal.canonicalSiteUrl, platform: "WOOCOMMERCE", shopifyShopId: null, status: "ACTIVE" }
    : overrides.shop as Record<string, unknown> | null;
  const installation = overrides.installation === undefined
    ? { id: principal.installationId, shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
      status: "ACTIVE", credentialVersion: 2, revokedAt: null }
    : overrides.installation as Record<string, unknown> | null;
  const settings = overrides.settings as Record<string, unknown> | undefined;
  const override = overrides.override as Record<string, unknown> | undefined;
  const row = shop && {
    shopId: shop.id, domain: shop.domain, platform: shop.platform, shopifyShopId: shop.shopifyShopId,
    shopStatus: shop.status, installationId: installation?.id ?? null,
    installationShopId: installation?.shopId ?? null, canonicalSiteUrl: installation?.canonicalSiteUrl ?? null,
    credentialVersion: installation?.credentialVersion ?? null, installationStatus: installation?.status ?? null,
    revokedAt: installation?.revokedAt ?? null,
    merchantRecoveryDelayMinutes: settings?.recoveryDelayMinutes ?? null,
    merchantRecoveryOfferMode: settings?.recoveryOfferMode ?? null,
    merchantFixedDiscountId: settings?.fixedShopifyDiscountId ?? null,
    merchantFollowUpEnabled: settings?.followUpEnabled ?? null,
    merchantFollowUpDelayMinutes: settings?.followUpDelayMinutes ?? null,
    overrideId: override ? "override_1" : null,
    overrideRecoveryDelayMinutes: override?.recoveryDelayMinutes ?? null,
    overrideRecoveryOfferMode: override?.recoveryOfferMode ?? null,
    overrideFixedDiscountId: override?.fixedShopifyDiscountId ?? null,
    overrideFollowUpEnabled: override?.followUpEnabled ?? null,
    overrideFollowUpDelayMinutes: override?.followUpDelayMinutes ?? null,
    overrideExpiresAt: override?.expiresAt ?? null,
  };
  return {
    $queryRaw: async () => { queries += 1; return row ? [row] : []; },
    queryCount: () => queries,
  };
}

const merchant = {
  recoveryDelayMinutes: 45, recoveryOfferMode: "NONE", fixedShopifyDiscountId: null,
  followUpEnabled: false, followUpDelayMinutes: null,
};

test("unconfigured Woo shop returns the same default that Background will execute, without writes", async () => {
  const database = mockDb();
  const result = await new MerchantRecoverySummaryService(database as never).read(principal);
  assert.deepEqual(result, { schemaVersion: 1, recoveryDelayMinutes: 30, recoveryOfferMode: "NONE",
    followUpEnabled: false, followUpDelayMinutes: null, source: "MERCHANT" });
  assert.equal(database.queryCount(), 1);
});

test("uses merchant policy when there is no active override", async () => {
  const result = await new MerchantRecoverySummaryService(mockDb({ settings: merchant }) as never).read(principal);
  assert.equal(result.recoveryDelayMinutes, 45);
  assert.equal(result.source, "MERCHANT");
});

test("an active admin override supersedes merchant settings", async () => {
  const result = await new MerchantRecoverySummaryService(mockDb({
    settings: merchant,
    override: { ...merchant, recoveryDelayMinutes: 90, followUpEnabled: true, followUpDelayMinutes: 120, expiresAt: null },
  }) as never).read(principal);
  assert.equal(result.recoveryDelayMinutes, 90);
  assert.equal(result.followUpDelayMinutes, 120);
  assert.equal(result.source, "ADMIN_OVERRIDE");
});

test("expired overrides do not affect current effective policy", async () => {
  const result = await new MerchantRecoverySummaryService(mockDb({
    settings: merchant,
    override: { ...merchant, recoveryDelayMinutes: 7, expiresAt: new Date("2026-01-01T00:00:00Z") },
  }) as never).read(principal, new Date("2026-10-09T00:00:00Z"));
  assert.equal(result.recoveryDelayMinutes, 45);
});

test("rejects stale credential version and foreign installation", async () => {
  await assert.rejects(() => new MerchantRecoverySummaryService(mockDb({
    installation: { id: principal.installationId, shopId: "another_shop", canonicalSiteUrl: principal.canonicalSiteUrl,
      status: "ACTIVE", credentialVersion: 2, revokedAt: null },
  }) as never).read(principal), RecoverySummaryIntegrityError);
  await assert.rejects(() => new MerchantRecoverySummaryService(mockDb({
    installation: { id: principal.installationId, shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
      status: "ACTIVE", credentialVersion: 1, revokedAt: null },
  }) as never).read(principal), RecoverySummaryIntegrityError);
});

test("invalid policy state fails closed instead of inventing values", async () => {
  await assert.rejects(() => new MerchantRecoverySummaryService(mockDb({
    settings: { ...merchant, followUpEnabled: true, followUpDelayMinutes: null },
  }) as never).read(principal));
});
