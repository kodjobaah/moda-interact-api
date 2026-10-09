import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import { MerchantBootstrapReadService } from "../bootstrap/bootstrap-read.service.js";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { MerchantStoreContextConflictError, MerchantStoreContextService } from "./store-context.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
let prisma: PrismaClient | undefined;
const database = () => prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl! } } });

test("PostgreSQL writes only the context snapshot, round-trips via bootstrap and preserves installation and billing", {
  skip: !databaseUrl,
}, async () => {
  const domain = `https://${randomUUID()}.woo-context.invalid`;
  let shopId: string | undefined;
  try {
    const shop = await database().shop.create({
      data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true },
    });
    shopId = shop.id;
    const installation = await database().wooCommerceInstallation.create({ data: {
      shopId, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32), credentialVersion: 2,
      status: "ACTIVE", revokedAt: null,
    } });
    const principal: WooInstallationPrincipal = {
      installationId: installation.id, shopId, canonicalSiteUrl: domain, credentialVersion: 2,
    };
    const service = new MerchantStoreContextService(database());
    const before = await database().shop.findUniqueOrThrow({ where: { id: shopId } });
    const snapshot = { schemaVersion: 1 as const, storeLocale: "en_GB", languageTag: "en-GB", timeZone: "Europe/London", countryCode: "GB" };
    await service.update(principal, snapshot);
    await service.update(principal, snapshot);
    const after = await database().shop.findUniqueOrThrow({ where: { id: shopId } });
    assert.deepEqual({
      ...after, updatedAt: before.updatedAt,
      storeLocale: before.storeLocale, defaultLanguageTag: before.defaultLanguageTag,
      defaultTimeZone: before.defaultTimeZone, defaultCountryCode: before.defaultCountryCode,
    }, before);
    assert.deepEqual((await new MerchantBootstrapReadService(database()).read(principal)).internationalContext, {
      storeLocale: "en_GB", languageTag: "en-GB", timeZone: "Europe/London", countryCode: "GB",
    });
    assert.deepEqual(await database().wooCommerceInstallation.findUnique({ where: { id: installation.id } }), installation);
    assert.equal(await database().subscription.count({ where: { shopId } }), 0);
    assert.equal(await database().shopEntitlementCounter.count({ where: { shopId } }), 0);
    assert.equal(await database().commerceShopProfile.count({ where: { shopId } }), 0);

    await service.update(principal, { schemaVersion: 1, storeLocale: null, languageTag: null, timeZone: null, countryCode: null });
    assert.deepEqual((await new MerchantBootstrapReadService(database()).read(principal)).internationalContext, {
      storeLocale: null, languageTag: null, timeZone: null, countryCode: null,
    });

    await assert.rejects(() => service.update({ ...principal, canonicalSiteUrl: "https://other.example" }, snapshot), MerchantStoreContextConflictError);
    await database().wooCommerceInstallation.update({ where: { id: installation.id }, data: { credentialVersion: { increment: 1 } } });
    await assert.rejects(() => service.update(principal, snapshot), MerchantStoreContextConflictError);
    await database().wooCommerceInstallation.update({ where: { id: installation.id }, data: { revokedAt: new Date() } });
    await assert.rejects(() => service.update({ ...principal, credentialVersion: 3 }, snapshot), MerchantStoreContextConflictError);
    assert.deepEqual((await new MerchantBootstrapReadService(database()).read(principal)).internationalContext, {
      storeLocale: null, languageTag: null, timeZone: null, countryCode: null,
    });
  } finally {
    if (shopId) await database().shop.deleteMany({ where: { id: shopId } });
  }
});

after(async () => { await prisma?.$disconnect(); });
