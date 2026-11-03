import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { MerchantRecoveryListService } from "../../../../src/merchant/recoveries/list.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

test("ARCH-055 zero-count recovery list skips its page query", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  const statements: string[] = [];
  const db = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [{ emit: "event", level: "query" }],
  });
  db.$on("query", event => statements.push(event.query));
  const id = () => randomUUID();
  const shopIds: string[] = [];
  try {
    const shop = await db.shop.create({ data: {
      domain: `https://woo-${id()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
    } });
    shopIds.push(shop.id);
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain,
      credentialDigest: Uint8Array.from(createHash("sha256").update(id()).digest()),
    } });
    const principal = { shopId: shop.id, canonicalSiteUrl: shop.domain,
      installationId: installation.id, credentialVersion: installation.credentialVersion };
    statements.length = 0;
    const result = await new MerchantRecoveryListService(db, () => new Date("2026-11-02T12:00:00.000Z"))
      .read(principal, new URLSearchParams({ from: "2026-11-01", to: "2026-11-02", page: "3" }));
    assert.equal(result.total, 0);
    assert.equal(result.page, 1);
    assert.equal(result.totalPages, 1);
    assert.deepEqual(result.items, []);
    const recoveryStatements = statements.filter(query => query.includes('"CheckoutRecovery"'));
    assert.equal(recoveryStatements.length, 1);
    assert.match(recoveryStatements[0]!, /COUNT\s*\(/i);
  } finally {
    if (shopIds.length) await db.shop.deleteMany({ where: { id: { in: shopIds } } });
    await db.$disconnect();
  }
});