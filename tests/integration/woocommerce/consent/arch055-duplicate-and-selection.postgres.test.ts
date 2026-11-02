import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { digestSecret } from "../../../../src/auth/woo-installation/credential.js";
import type { WooConsentEvent } from "../../../../src/woocommerce/consent/contract.js";
import { WooConsentService } from "../../../../src/woocommerce/consent/service.js";
import { WooRecoverySelectionService } from "../../../../src/woocommerce/recovery-selection/service.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";

const databaseUrl = process.env.WOO_CONSENT_TEST_DATABASE_URL;
const now = new Date("2026-10-22T16:00:00.000Z");
const phone = "447400123463";
const observedAt = (secondsBeforeNow: number) =>
  new Date(now.getTime() - secondsBeforeNow * 1000).toISOString();

function event(id: string, decision: "GRANT" | "REVOKE", secondsBeforeNow: number): WooConsentEvent {
  const example = consentEvent();
  return consentEvent({ eventId: id, decision, canonicalPhone: phone,
    occurredAt: observedAt(secondsBeforeNow), disclosure: decision === "GRANT" ? example.disclosure : null });
}

async function setup() {
  if (!databaseUrl) throw new Error("WOO_CONSENT_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const feature = await db.feature.findUniqueOrThrow({ where: { key: "checkout_recovery" } });
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `arch055-consent-${randomUUID()}`, name: "ARCH-055 consent", kind: "FREE",
    } });
    await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id, enabled: true } });
    const site = `https://arch055-consent-${randomUUID()}.invalid`;
    const shop = await db.shop.create({ data: { domain: site, platform: "WOOCOMMERCE", onboardingCompleted: true } });
    await db.subscription.create({ data: { shopId: shop.id, planId: plan.id, status: "ACTIVE" } });
    const secret = Buffer.alloc(32, 0x42);
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: site, credentialDigest: Uint8Array.from(digestSecret(secret)),
    } });
    const principal = { shopId: shop.id, installationId: installation.id,
      canonicalSiteUrl: site, credentialVersion: installation.credentialVersion };
    return { db, shop, principal, service: new WooConsentService(db, () => now) };
  } catch (error) {
    await db.$disconnect();
    throw error;
  }
}

test("consent replay returns historical evidence without waiting for recipient lock or restoring STOP", {
  skip: !databaseUrl,
}, async () => {
  const { db, shop, principal, service } = await setup();
  try {
    const grant = event("replay-after-stop", "GRANT", 100);
    const original = await service.record(principal, grant);
    await service.record(principal, event("later-revoke", "REVOKE", 80));
    await db.$executeRaw`
      UPDATE "commerce"."CustomerPhone" SET "whatsappNoContact" = TRUE,
        "whatsappNoContactReason" = 'CUSTOMER_STOP', "whatsappNoContactAt" = ${now},
        "whatsappNoContactRevision" = "whatsappNoContactRevision" + 1
      WHERE "whatsappCanonicalPhone" = ${phone}
    `;

    const replay = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(
        hashtext(${shop.id}), hashtext(${`phone:${phone}`}))`;
      return service.record(principal, grant);
    });
    assert.deepEqual(replay, { ...original, status: "duplicate" });
    const current = await db.$queryRaw<Array<{ decision: string; noContact: boolean; reason: string | null }>>`
      SELECT "whatsappConsentDecision"::text AS decision, "whatsappNoContact" AS "noContact",
        "whatsappNoContactReason"::text AS reason FROM "commerce"."CustomerPhone"
      WHERE "whatsappCanonicalPhone" = ${phone}
    `;
    assert.deepEqual(current.map(row => [row.decision, row.noContact, row.reason]),
      [["REVOKED", true, "CUSTOMER_STOP"]]);
    assert.equal(await db.whatsAppConsentEvidence.count({ where: { shopId: shop.id } }), 2);
  } finally { await db.$disconnect(); }
});

test("recovery-selection GET reads through a held phone row lock", {
  skip: !databaseUrl,
}, async () => {
  const { db, principal, service } = await setup();
  try {
    await service.record(principal, event("selection-get-grant", "GRANT", 100));
    const selection = new WooRecoverySelectionService(db);
    const status = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "commerce"."CustomerPhone"
        WHERE "whatsappCanonicalPhone" = ${phone} FOR UPDATE`;
      return selection.read(principal, phone);
    });
    assert.equal(status.phoneEligibleForRecovery, true);
    assert.equal(status.noContactRevision, "0");
  } finally { await db.$disconnect(); }
});
