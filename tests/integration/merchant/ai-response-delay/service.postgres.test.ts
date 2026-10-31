import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test from "node:test";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { AiResponseDelayConflictError, AiResponseDelayUnauthorizedError } from "../../../../src/merchant/ai-response-delay/contract.js";
import { MerchantAiResponseDelayService } from "../../../../src/merchant/ai-response-delay/service.js";

const databaseUrl = process.env.WOO_AI_RESPONSE_DELAY_TEST_DATABASE_URL;

test("ARCH-054 response delay: tenant isolation, defaults, no-op, CAS race and revocation", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = randomUUID();
  const shopIds: string[] = [];
  const installationIds: string[] = [];
  try {
    const [shop, otherShop] = await Promise.all([
      db.shop.create({ data: { domain: `https://${suffix}-one.invalid`, platform: "WOOCOMMERCE" } }),
      db.shop.create({ data: { domain: `https://${suffix}-two.invalid`, platform: "WOOCOMMERCE" } }),
    ]);
    shopIds.push(shop.id, otherShop.id);
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain, credentialDigest: Buffer.alloc(32),
    } });
    installationIds.push(installation.id);
    const principal: WooInstallationPrincipal = {
      shopId: shop.id, canonicalSiteUrl: shop.domain, installationId: installation.id,
      credentialVersion: installation.credentialVersion,
    };
    const service = new MerchantAiResponseDelayService(db);

    const absent = await service.read(principal);
    assert.deepEqual(absent, { schemaVersion: 1, revision: "UNCONFIGURED", aiResponseDelayMinutes: 0 });
    const created = await service.update(principal, {
      schemaVersion: 1, expectedRevision: "UNCONFIGURED", aiResponseDelayMinutes: 7,
    });
    assert.equal(created.aiResponseDelayMinutes, 7);
    const settings = await db.shopSettings.findUniqueOrThrow({ where: { shopId: shop.id } });
    assert.equal(settings.shopId, shop.id);
    assert.equal(settings.recoveryDelayMinutes, 30);
    assert.equal(settings.recoveryOfferMode, "NONE");
    assert.equal(settings.followUpEnabled, false);

    const stable = await service.update(principal, {
      schemaVersion: 1, expectedRevision: "UNCONFIGURED", aiResponseDelayMinutes: 7,
    });
    assert.equal(stable.revision, created.revision);
    assert.equal((await db.shopSettings.findUniqueOrThrow({ where: { shopId: shop.id } })).updatedAt.toISOString(), created.revision);

    await db.shopSettings.update({ where: { shopId: shop.id }, data: {
      recoveryDelayMinutes: 17, followUpEnabled: true, followUpDelayMinutes: 60,
      notifyOnInitialRecoveryOutreach: true,
    } });
    const before = await db.shopSettings.findUniqueOrThrow({ where: { shopId: shop.id } });
    const [first, second] = await Promise.allSettled([
      service.update(principal, { schemaVersion: 1, expectedRevision: before.updatedAt.toISOString(), aiResponseDelayMinutes: 0 }),
      service.update(principal, { schemaVersion: 1, expectedRevision: before.updatedAt.toISOString(), aiResponseDelayMinutes: 30 }),
    ]);
    assert.equal([first, second].filter((result) => result.status === "fulfilled").length, 1);
    const rejected = [first, second].find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof AiResponseDelayConflictError);
    const after = await db.shopSettings.findUniqueOrThrow({ where: { shopId: shop.id } });
    assert.equal(after.recoveryDelayMinutes, 17);
    assert.equal(after.followUpEnabled, true);
    assert.equal(after.followUpDelayMinutes, 60);
    assert.equal(after.notifyOnInitialRecoveryOutreach, true);
    assert.ok([0, 30].includes(after.aiResponseDelayMinutes));

    await assert.rejects(() => service.read({ ...principal, shopId: otherShop.id }), AiResponseDelayUnauthorizedError);
    await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    await assert.rejects(() => service.update(principal, {
      schemaVersion: 1, expectedRevision: after.updatedAt.toISOString(), aiResponseDelayMinutes: 7,
    }), AiResponseDelayUnauthorizedError);
    assert.equal((await db.shopSettings.findUniqueOrThrow({ where: { shopId: shop.id } })).aiResponseDelayMinutes,
      after.aiResponseDelayMinutes);
  } finally {
    if (installationIds.length) await db.wooCommerceInstallation.deleteMany({ where: { id: { in: installationIds } } });
    if (shopIds.length) await db.shop.deleteMany({ where: { id: { in: shopIds } } });
    await db.$disconnect();
  }
});