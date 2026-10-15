import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { MerchantDiscountOffersService } from "./service.js";
import { DiscountOffersError } from "./contract.js";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";

const url = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const now = new Date("2026-10-15T12:00:00Z");

test("API-004 settings GET survives missing and failed Woo catalogues without changing merchant state", { skip: !url }, async () => {
  if (!url) return;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const domain = `https://${randomUUID()}.api004.invalid`;
  const shop = await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE" } });
  let adminId: string | null = null;
  try {
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32),
    } });
    const principal: WooInstallationPrincipal = { shopId: shop.id, installationId: installation.id,
      canonicalSiteUrl: domain, credentialVersion: installation.credentialVersion };
    const service = new MerchantDiscountOffersService(db, () => now);

    const noCatalogue = await service.read(principal);
    assert.equal(noCatalogue.merchant.recoveryOfferMode, "NONE");
    assert.deepEqual(noCatalogue.merchant.selectedDiscountIds, []);
    assert.equal(noCatalogue.effective.recoveryOfferMode, "NONE");
    assert.equal(noCatalogue.overrideActive, false);
    await assert.rejects(() => service.catalogue(principal, { limit: 10 }),
      (error: unknown) => error instanceof DiscountOffersError && error.code === "catalogue_not_current");

    await db.shopifyDiscountCatalogue.create({ data: { shopId: shop.id, status: "SYNC_REQUIRED" } });
    const coupon = await db.shopifyDiscount.create({ data: {
      shopId: shop.id, shopifyDiscountNodeId: "woo:coupon:1", providerType: "WooCoupon:code",
      method: "CODE", providerStatus: "REMOVED", fixedSelectable: false, codeCount: 1,
      singleRedeemCode: "KEEP", title: "KEEP", providerSnapshot: { provider: "WOOCOMMERCE" },
      isAvailable: true, lastSeenSyncGeneration: 1, lastSyncedAt: now,
    } });
    await db.shopSettings.create({ data: {
      shopId: shop.id, recoveryOfferMode: "FIXED", fixedShopifyDiscountId: coupon.id,
    } });
    const admin = await db.platformAdmin.create({ data: { email: `${randomUUID()}@api004.invalid` } });
    adminId = admin.id;
    await db.shopRecoveryPolicyOverride.create({ data: {
      shopId: shop.id, recoveryDelayMinutes: 60, recoveryOfferMode: "AI_BEST_APPLICABLE",
      followUpEnabled: false, followUpDelayMinutes: null, reason: "API-004 regression",
      updatedByPlatformAdminId: admin.id,
    } });
    const before = await db.shopSettings.findUniqueOrThrow({ where: { shopId: shop.id } });
    const beforeCoupon = await db.shopifyDiscount.findUniqueOrThrow({ where: { id: coupon.id } });
    for (const status of ["SYNC_REQUIRED", "SYNCING", "ERROR", "UNAVAILABLE", "CURRENT"] as const) {
      await db.shopifyDiscountCatalogue.update({ where: { shopId: shop.id }, data: {
        status, syncGeneration: 2, lastSuccessfulSyncAt: status === "CURRENT" ? now : null,
        activeSyncToken: status === "SYNCING" ? "scan" : null,
        syncStartedAt: status === "SYNCING" ? now : null,
      } });
      const settings = await service.read(principal);
      assert.equal(settings.merchant.recoveryOfferMode, "FIXED", status);
      assert.deepEqual(settings.merchant.selectedDiscountIds, [coupon.id], status);
      assert.equal(settings.effective.recoveryOfferMode, "AI_BEST_APPLICABLE", status);
      assert.equal(settings.source, "ADMIN_OVERRIDE", status);
      assert.equal(settings.overrideActive, true, status);
      assert.equal(typeof settings.revision, "string", status);
      if (status !== "CURRENT") await assert.rejects(() => service.catalogue(principal, { limit: 10 }),
        (error: unknown) => error instanceof DiscountOffersError && error.code === "catalogue_not_current");
    }
    assert.deepEqual(await db.shopSettings.findUniqueOrThrow({ where: { shopId: shop.id } }), before);
    assert.deepEqual(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: coupon.id } }), beforeCoupon);

    await db.shopifyDiscountCatalogue.update({ where: { shopId: shop.id }, data: { status: "ERROR" } });
    const saved = await service.save(principal, { recoveryOfferMode: "NONE", selectedDiscountIds: [coupon.id] });
    assert.equal(saved.merchant.recoveryOfferMode, "NONE");
    assert.deepEqual(saved.merchant.selectedDiscountIds, [coupon.id]);
    const ai = await service.save(principal, { recoveryOfferMode: "AI_BEST_APPLICABLE", selectedDiscountIds: [coupon.id] });
    assert.equal(ai.merchant.recoveryOfferMode, "AI_BEST_APPLICABLE");
    assert.equal((await db.shopifyDiscount.findUniqueOrThrow({ where: { id: coupon.id } })).isAvailable, true);
    assert.equal((await db.shopifyDiscount.findUniqueOrThrow({ where: { id: coupon.id } })).providerStatus, "REMOVED");
    assert.equal((await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId: shop.id } })).status, "ERROR");
    await assert.rejects(() => service.read({ ...principal, credentialVersion: principal.credentialVersion + 1 }),
      (error: unknown) => error instanceof DiscountOffersError && error.code === "shop_unavailable");
    await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { status: "REVOKED" } });
    await assert.rejects(() => service.read(principal),
      (error: unknown) => error instanceof DiscountOffersError && error.code === "shop_unavailable");
  } finally {
    await db.shop.delete({ where: { id: shop.id } }).catch(() => {});
    if (adminId) await db.platformAdmin.delete({ where: { id: adminId } }).catch(() => {});
    await db.$disconnect();
  }
});

test("API-004 catalogue lists merchant-selectable Woo codes irrespective of commercial rules", { skip: !url }, async () => {
  if (!url) return;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const domain = `https://${randomUUID()}.api004-catalogue.invalid`;
  const shop = await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE" } });
  const other = await db.shop.create({ data: { domain: `${domain}-other`, platform: "WOOCOMMERCE", status: "ACTIVE" } });
  const shopify = await db.shop.create({ data: { domain: `${domain}-shopify`, platform: "SHOPIFY", status: "ACTIVE" } });
  try {
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32),
    } });
    const principal: WooInstallationPrincipal = { shopId: shop.id, installationId: installation.id,
      canonicalSiteUrl: domain, credentialVersion: installation.credentialVersion };
    await db.shopifyDiscountCatalogue.createMany({ data: [
      { shopId: shop.id, status: "CURRENT", syncGeneration: 5, lastSuccessfulSyncAt: now },
      { shopId: other.id, status: "CURRENT", syncGeneration: 5, lastSuccessfulSyncAt: now },
      { shopId: shopify.id, status: "CURRENT", syncGeneration: 5, lastSuccessfulSyncAt: now },
    ] });
    const create = (shopId: string, ordinal: number, updates: Partial<Prisma.ShopifyDiscountUncheckedCreateInput> = {}) =>
      db.shopifyDiscount.create({ data: {
        shopId, shopifyDiscountNodeId: `woo:coupon:${ordinal}`, providerType: "WooCoupon:code",
        method: "CODE", providerStatus: "ACTIVE", fixedSelectable: true, codeCount: 1,
        title: `COUPON-${ordinal}`, singleRedeemCode: `COUPON-${ordinal}`,
        providerSnapshot: { provider: "WOOCOMMERCE", discountType: "third-party" },
        isAvailable: false, lastSeenSyncGeneration: 5, lastSyncedAt: now,
        ...updates,
      } });
    const unknown = await create(shop.id, 1, { fixedSelectable: false, providerSnapshot: {
      provider: "WOOCOMMERCE", discountType: "plugin-defined-custom-type" },
    });
    const zero = await create(shop.id, 2, { providerStatus: "UNSUPPORTED", fixedSelectable: false,
      providerSnapshot: { provider: "WOOCOMMERCE", amount: "0" } });
    const expired = await create(shop.id, 3, { providerStatus: "EXPIRED", fixedSelectable: false,
      endsAt: new Date("2026-10-01T00:00:00Z"), isAvailable: true });
    const exhausted = await create(shop.id, 4, { providerStatus: "EXHAUSTED", fixedSelectable: false,
      startsAt: new Date("2026-11-01T00:00:00Z") });
    const longCode = "L".repeat(320);
    const long = await create(shop.id, 5, { singleRedeemCode: longCode, title: "LONG" });
    await create(shop.id, 6, { providerStatus: "UNDELIVERABLE", codeCount: 0, singleRedeemCode: null });
    await create(shop.id, 7, { singleRedeemCode: "BAD\nCONTROL" });
    await create(shop.id, 8, { providerStatus: "REMOVED", unavailableAt: now });
    await create(shop.id, 9, { lastSeenSyncGeneration: 4 });
    await create(shop.id, 10, { singleRedeemCode: null, codeCount: 0 });
    await create(other.id, 11);
    await create(shop.id, 12, { providerType: "Shopify" });
    await create(shop.id, 13, { shopifyDiscountNodeId: "gid://shopify/Discount/13" });
    await db.shopifyDiscount.create({ data: { shopId: shopify.id,
      shopifyDiscountNodeId: "gid://shopify/Discount/1", providerType: "Shopify",
      method: "CODE", providerStatus: "ACTIVE", title: "SHOPIFY", codeCount: 1,
      singleRedeemCode: "SHOPIFY", isAvailable: true, fixedSelectable: true,
      providerSnapshot: {}, lastSeenSyncGeneration: 5, lastSyncedAt: now } });

    // More than a full batch of legacy non-sendable codes must not truncate
    // paging or cause the API to leak unsafe coupon codes.
    await db.shopifyDiscount.createMany({ data: Array.from({ length: 105 }, (_, i) => ({
      id: `a-invalid-${String(i).padStart(3, "0")}-${shop.id}`,
      shopId: shop.id, shopifyDiscountNodeId: `woo:coupon:${1000 + i}`,
      providerType: "WooCoupon:code", method: "CODE" as const, providerStatus: "ACTIVE",
      fixedSelectable: false, codeCount: 1, title: `BAD-${i}`,
      singleRedeemCode: "UNSAFE\nCODE", providerSnapshot: { provider: "WOOCOMMERCE" },
      isAvailable: false, lastSeenSyncGeneration: 5, lastSyncedAt: now,
    })) });

    const service = new MerchantDiscountOffersService(db, () => now);
    const expected = [unknown.id, zero.id, expired.id, exhausted.id, long.id].sort();
    const all = await service.catalogue(principal, { limit: 50 });
    assert.deepEqual(all.items.map(item => item.id).sort(), expected);
    assert.equal(all.items.find(item => item.id === expired.id)?.selected, true);
    assert.equal(all.items.find(item => item.id === long.id)?.code, longCode);
    const search = await service.catalogue(principal, { limit: 10, search: "LONG" });
    assert.deepEqual(search.items.map(item => item.id), [long.id]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.catalogue(principal, { limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map(item => item.id));
      if (!page.hasMore) break;
      assert.ok(page.nextCursor);
      cursor = page.nextCursor!;
    } while (seen.length <= 20);
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, seen.length, "pagination must not duplicate entries");
    await assert.rejects(() => service.catalogue({ ...principal, shopId: other.id }, { limit: 10 }), DiscountOffersError);
    await assert.rejects(() => service.catalogue({ ...principal, shopId: shopify.id }, { limit: 10 }), DiscountOffersError);
    await db.shopifyDiscountCatalogue.update({ where: { shopId: shop.id }, data: {
      status: "SYNCING", activeSyncToken: "pending", syncStartedAt: now,
    } });
    await assert.rejects(() => service.catalogue(principal, { limit: 10 }),
      (error: unknown) => error instanceof DiscountOffersError && error.code === "catalogue_not_current");
  } finally {
    for (const id of [shop.id, other.id, shopify.id]) await db.shop.delete({ where: { id } }).catch(() => {});
    await db.$disconnect();
  }
});
