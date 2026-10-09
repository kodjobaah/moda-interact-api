import assert from "node:assert/strict";
import test from "node:test";
import { MerchantRecoverySummaryService, RecoverySummaryIntegrityError } from "./recovery-summary.service.js";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";

const principal: WooInstallationPrincipal = {
  installationId: "install_1", shopId: "shop_1", canonicalSiteUrl: "https://woo.example",
  credentialVersion: 2,
};

function mockDb(overrides: { settings?: unknown; override?: unknown; shop?: unknown; installation?: unknown } = {}) {
  return {
    shop: { findUnique: async () => overrides.shop === undefined
      ? { id: principal.shopId, domain: principal.canonicalSiteUrl, platform: "WOOCOMMERCE", shopifyShopId: null, status: "ACTIVE" }
      : overrides.shop },
    wooCommerceInstallation: { findUnique: async () => overrides.installation === undefined
      ? { id: principal.installationId, shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
        status: "ACTIVE", credentialVersion: 2, revokedAt: null }
      : overrides.installation },
    shopSettings: { findUnique: async () => overrides.settings ?? null },
    shopRecoveryPolicyOverride: { findUnique: async () => overrides.override ?? null },
  };
}

const merchant = {
  recoveryDelayMinutes: 45, recoveryOfferMode: "NONE", fixedShopifyDiscountId: null,
  followUpEnabled: false, followUpDelayMinutes: null,
};

test("unconfigured Woo shop returns the same default that Background will execute, without writes", async () => {
  const result = await new MerchantRecoverySummaryService(mockDb() as never).read(principal);
  assert.deepEqual(result, { schemaVersion: 1, recoveryDelayMinutes: 30, recoveryOfferMode: "NONE",
    followUpEnabled: false, followUpDelayMinutes: null, source: "MERCHANT" });
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
