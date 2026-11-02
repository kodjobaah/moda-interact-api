import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import { MerchantBootstrapReadService } from "../../../../src/merchant/bootstrap/bootstrap-read.service.js";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { MerchantStoreContextConflictError, MerchantStoreContextService } from "../../../../src/merchant/store-context/store-context.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
type QueryEventClient = { $on(event: "query", listener: (event: { query: string }) => void): void };
let prisma: PrismaClient | undefined;
const shopUpdates: number[] = [];
const shopUpdateSql: string[] = [];
const database = () => {
  if (!prisma) {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } }, log: [{ emit: "event", level: "query" }] });
    (prisma as unknown as QueryEventClient).$on("query", (event) => {
      if (/^\s*UPDATE/i.test(event.query) && event.query.includes('"Shop"')) shopUpdateSql.push(event.query);
    });
  }
  return prisma;
};

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
    const storeContextDatabase = {
      shop: { updateMany: async (args: Parameters<ReturnType<typeof database>["shop"]["updateMany"]>[0]) => {
        const result = await database().shop.updateMany(args);
        shopUpdates.push(result.count);
        return result;
      } },
    };
    const service = new MerchantStoreContextService(storeContextDatabase as never);
    const before = await database().shop.findUniqueOrThrow({ where: { id: shopId } });
    const snapshot = { schemaVersion: 1 as const, storeLocale: "en_GB", languageTag: "en-GB", timeZone: "Europe/London", countryCode: "GB" };
    const sqlBeforeEqualWrites = shopUpdateSql.length;
    await service.update(principal, snapshot);
    await service.update(principal, snapshot);
    assert.deepEqual(shopUpdates.slice(0, 2), [1, 1]);
    assert.equal(shopUpdateSql.length - sqlBeforeEqualWrites, 2);
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

    const beforeStalePrincipalSql = shopUpdateSql.length;
    await assert.rejects(() => service.update({ ...principal, canonicalSiteUrl: "https://other.example" }, snapshot), MerchantStoreContextConflictError);
    assert.equal(shopUpdates.at(-1), 0);
    assert.equal(shopUpdateSql.length - beforeStalePrincipalSql, 1);
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
