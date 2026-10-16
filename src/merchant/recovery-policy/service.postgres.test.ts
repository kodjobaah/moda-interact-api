import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test from "node:test";
import { MerchantRecoveryPolicyService } from "./service.js";
import { RecoveryPolicyConflictError, RecoveryPolicyIntegrityError } from "./contract.js";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

/** Integration proof is opt-in: use only a disposable migration-current PostgreSQL test database. */
test("PostgreSQL recovery-policy GET/PUT locks the Shop and preserves override precedence", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const domain = `https://${randomUUID()}.woo-policy.invalid`;
  const adminEmail = `${randomUUID()}@woo-policy.invalid`;
  let shopId: string | undefined;
  let adminId: string | undefined;
  try {
    const shop = await db.shop.create({ data: {
      domain, platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true,
    } });
    shopId = shop.id;
    const persistedShopId: string = shop.id;
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: persistedShopId, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32),
    } });
    const principal: WooInstallationPrincipal = {
      shopId: persistedShopId, canonicalSiteUrl: domain, installationId: installation.id, credentialVersion: installation.credentialVersion,
    };
    const service = new MerchantRecoveryPolicyService(db);
    const initial = await service.read(principal);
    assert.equal(initial.revision, "UNCONFIGURED");
    assert.equal(initial.merchant.recoveryDelayMinutes, 30);
    assert.equal(await db.shopSettings.count({ where: { shopId: persistedShopId } }), 0);

    const first = await service.update(principal, {
      expectedRevision: "UNCONFIGURED", recoveryDelayMinutes: 45, followUpEnabled: true, followUpDelayMinutes: 50,
    });
    const row = await db.shopSettings.findUniqueOrThrow({ where: { shopId: persistedShopId } });
    assert.equal(row.recoveryOfferMode, "NONE");
    assert.equal(row.fixedShopifyDiscountId, null);
    assert.equal(row.recoveryDelayMinutes, 45);
    assert.equal(row.followUpEnabled, true);
    assert.equal(row.followUpDelayMinutes, 50);
    assert.equal(first.merchant.recoveryDelayMinutes, 45);
    assert.equal(first.effective.recoveryDelayMinutes, 45);

    // The identical request is an idempotent replay and must not create a new revision.
    const replay = await service.update(principal, {
      expectedRevision: "UNCONFIGURED", recoveryDelayMinutes: 45, followUpEnabled: true, followUpDelayMinutes: 50,
    });
    assert.equal(replay.revision, first.revision);

    const [one, two] = await Promise.allSettled([
      service.update(principal, { expectedRevision: first.revision, recoveryDelayMinutes: 55,
        followUpEnabled: true, followUpDelayMinutes: 90 }),
      service.update(principal, { expectedRevision: first.revision, recoveryDelayMinutes: 65,
        followUpEnabled: true, followUpDelayMinutes: 120 }),
    ]);
    assert.equal([one, two].filter((result) => result.status === "fulfilled").length, 1);
    const loser = [one, two].find((result) => result.status === "rejected");
    assert.ok(loser && loser.status === "rejected");
    assert.ok(loser.reason instanceof RecoveryPolicyConflictError);
    assert.equal(loser.reason.code, "recovery_policy_conflict");

    const admin = await db.platformAdmin.create({ data: { email: adminEmail } });
    adminId = admin.id;
    await db.shopRecoveryPolicyOverride.create({ data: {
      shopId: persistedShopId, reason: "API-002 integration proof", updatedByPlatformAdminId: admin.id,
      recoveryDelayMinutes: 90, recoveryOfferMode: "NONE", fixedShopifyDiscountId: null,
      followUpEnabled: false, followUpDelayMinutes: null,
    } });
    const override = await service.read(principal);
    assert.equal(override.source, "ADMIN_OVERRIDE");
    assert.equal(override.effective.recoveryDelayMinutes, 90);
    assert.notEqual(override.merchant.recoveryDelayMinutes, 90);
    const changed = await service.update(principal, { expectedRevision: override.revision, recoveryDelayMinutes: 20,
      followUpEnabled: false, followUpDelayMinutes: null });
    assert.equal(changed.merchant.recoveryDelayMinutes, 20);
    assert.equal(changed.effective.recoveryDelayMinutes, 90);
    assert.equal(await db.shopRecoveryPolicyOverride.count({ where: { shopId: persistedShopId } }), 1);

    await db.shopRecoveryPolicyOverride.update({ where: { shopId: persistedShopId }, data: { expiresAt: new Date("2000-01-01T00:00:00.000Z") } });
    const expired = await service.read(principal);
    assert.equal(expired.source, "MERCHANT");
    assert.equal(expired.effective.recoveryDelayMinutes, 20);

    await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { credentialVersion: { increment: 1 } } });
    await assert.rejects(() => service.update(principal, { expectedRevision: expired.revision,
      recoveryDelayMinutes: 20, followUpEnabled: false, followUpDelayMinutes: null }), RecoveryPolicyIntegrityError);
    await assert.rejects(() => service.read({ ...principal, shopId: randomUUID() }), RecoveryPolicyIntegrityError);
  } finally {
    if (shopId) await db.shop.delete({ where: { id: shopId } });
    if (adminId) await db.platformAdmin.delete({ where: { id: adminId } });
    await db.$disconnect();
  }
});
