import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { MerchantDiscountOffersService } from "../../../../src/merchant/discount-offers/service.js";
import { DiscountOffersError } from "../../../../src/merchant/discount-offers/contract.js";
import type { WooInstallationPrincipal } from "../../../../src/woocommerce/installation/authenticator.js";

const now = new Date("2026-10-15T12:00:00Z");
const principal: WooInstallationPrincipal = { shopId: "woo-shop", installationId: "installation",
  canonicalSiteUrl: "https://woo.test", credentialVersion: 1 };

function harness() {
  let catalogue: { status: string; syncGeneration: number; updatedAt: Date;
    lastSuccessfulSyncAt: Date | null; activeSyncToken: string | null; syncStartedAt: Date | null } | null = null;
  let installationStatus = "ACTIVE";
  let platform = "WOOCOMMERCE";
  let catalogueQueries = 0;
  const coupon = { id: "woo-coupon", title: "EXPIRED", summary: null, providerType: "WooCoupon:code",
    singleRedeemCode: "EXPIRED", startsAt: null, endsAt: new Date("2026-10-01T00:00:00Z"),
    isAvailable: true };
  const tx = {
    $queryRaw: async () => [{ id: principal.shopId, domain: principal.canonicalSiteUrl,
      platform, status: "ACTIVE", shopifyShopId: null }],
    wooCommerceInstallation: { findUnique: async () => ({ id: principal.installationId,
      shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
      status: installationStatus, credentialVersion: 1, revokedAt: null }) },
    shopifyDiscountCatalogue: { findUnique: async () => catalogue },
    shopSettings: { findUnique: async () => ({ updatedAt: now, recoveryOfferMode: "FIXED" }) },
    shopRecoveryPolicyOverride: { findUnique: async () => null },
    shopifyDiscount: { findMany: async (args: { where?: { AND?: unknown[] } }) => {
      if (args.where?.AND) {
        catalogueQueries++;
        return [coupon];
      }
      return [{ id: coupon.id }];
    } },
  };
  const database = { $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) };
  const service = new MerchantDiscountOffersService(database as unknown as Pick<PrismaClient, "$transaction">, () => now);
  return { service, setCatalogue(value: typeof catalogue) { catalogue = value; },
    setInstallationStatus(value: string) { installationStatus = value; },
    setPlatform(value: string) { platform = value; },
    catalogueQueries() { return catalogueQueries; } };
}

test("settings remain independently readable without a completed coupon catalogue", async () => {
  const h = harness();
  for (const status of [null, "SYNC_REQUIRED", "SYNCING", "ERROR", "UNAVAILABLE", "CURRENT"] as const) {
    h.setCatalogue(status ? { status, syncGeneration: 4, updatedAt: now,
      lastSuccessfulSyncAt: status === "CURRENT" ? now : null,
      activeSyncToken: status === "SYNCING" ? "token" : null,
      syncStartedAt: status === "SYNCING" ? now : null } : null);
    const result = await h.service.read(principal);
    assert.equal(result.merchant.recoveryOfferMode, "FIXED");
    assert.deepEqual(result.merchant.selectedDiscountIds, ["woo-coupon"]);
    assert.equal(result.effective.recoveryOfferMode, "FIXED");
    assert.equal(result.source, "MERCHANT");
    assert.equal(typeof result.revision, "string");
    if (status !== "CURRENT") await assert.rejects(() => h.service.catalogue(principal, { limit: 10 }),
      (error: unknown) => error instanceof DiscountOffersError && error.code === "catalogue_not_current");
  }
  assert.equal(h.catalogueQueries(), 0, "settings reads must not browse coupons");
  const result = await h.service.catalogue(principal, { limit: 10 });
  assert.deepEqual(result.items.map(item => item.code), ["EXPIRED"]);
  assert.equal(h.catalogueQueries(), 1);
});

test("still denies revoked, mismatched and Shopify shop principals", async () => {
  const h = harness();
  h.setInstallationStatus("REVOKED");
  await assert.rejects(() => h.service.read(principal),
    (error: unknown) => error instanceof DiscountOffersError && error.code === "shop_unavailable");
  h.setInstallationStatus("ACTIVE");
  await assert.rejects(() => h.service.read({ ...principal, credentialVersion: 2 }),
    (error: unknown) => error instanceof DiscountOffersError && error.code === "shop_unavailable");
  h.setPlatform("SHOPIFY");
  await assert.rejects(() => h.service.read(principal),
    (error: unknown) => error instanceof DiscountOffersError && error.code === "shop_unavailable");
});
