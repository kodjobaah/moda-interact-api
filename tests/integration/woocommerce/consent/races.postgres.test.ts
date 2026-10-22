import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { digestSecret, encodeSecret } from "../../../../src/auth/woo-installation/credential.js";
import { WooConsentHttpError, type WooConsentEvent } from "../../../../src/woocommerce/consent/contract.js";
import { createWooConsentRoute } from "../../../../src/woocommerce/consent/routes.js";
import { WooConsentService } from "../../../../src/woocommerce/consent/service.js";
import { WooInstallationConnectionService } from "../../../../src/woocommerce/installation/connection-service.js";
import { canonicalizeWooSiteUrl } from "../../../../src/woocommerce/installation/site-url.js";
import { WooSiteVerifier } from "../../../../src/woocommerce/installation/site-verifier.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";

const databaseUrl = process.env.WOO_CONSENT_TEST_DATABASE_URL;
const now = new Date("2026-10-22T16:00:00.000Z");
const phoneA = "447400123463";
const phoneB = "447400123464";
const observedAt = (secondsBeforeNow: number) =>
  new Date(now.getTime() - secondsBeforeNow * 1000).toISOString();

function event(site: string, id: string, decision: "GRANT" | "REVOKE",
  secondsBeforeNow: number, phone = phoneA, checkoutKey = "same-woo-cart"): WooConsentEvent {
  const example = consentEvent();
  return consentEvent({
    eventId: id, decision, canonicalPhone: phone,
    checkoutAction: { ...example.checkoutAction, checkoutKey,
      occurredAt: observedAt(secondsBeforeNow), serverObservedPhone: `+${phone}`,
      selection: decision === "GRANT" ? "CHECKED" : "UNCHECKED" },
    disclosure: decision === "GRANT" ? { ...example.disclosure!, merchantSiteUrl: site,
      text: `Allow ${site} to send WhatsApp abandoned-checkout marketing reminders.` } : null,
  });
}

async function setup() {
  if (!databaseUrl) throw new Error("WOO_CONSENT_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const feature = await db.feature.findUniqueOrThrow({ where: { key: "checkout_recovery" } });
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `woo-consent-races-${randomUUID()}`, name: "Woo consent races", kind: "FREE",
    } });
    await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id, enabled: true } });
    const site = `https://woo-consent-races-${randomUUID()}.invalid`;
    const shop = await db.shop.create({ data: {
      domain: site, platform: "WOOCOMMERCE", onboardingCompleted: true,
    } });
    await db.subscription.create({ data: { shopId: shop.id, planId: plan.id, status: "ACTIVE" } });
    const secret = Buffer.alloc(32, 0x42);
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: site,
      credentialDigest: Uint8Array.from(digestSecret(secret)),
    } });
    return { db, shop, site, secret, installation,
      principal: { shopId: shop.id, installationId: installation.id,
        canonicalSiteUrl: site, credentialVersion: installation.credentialVersion },
      service: new WooConsentService(db, () => now) };
  } catch (error) {
    await db.$disconnect();
    throw error;
  }
}

async function phones(db: PrismaClient, shopId: string) {
  return db.$queryRaw<Array<{ canonical: string; decision: string; revision: bigint;
    noContact: boolean; reason: string | null; noContactRevision: bigint; id: string }>>`
    SELECT cp."id", cp."whatsappCanonicalPhone" AS "canonical",
      cp."whatsappConsentDecision"::text AS "decision", cp."whatsappConsentRevision" AS "revision",
      cp."whatsappNoContact" AS "noContact", cp."whatsappNoContactReason"::text AS "reason",
      cp."whatsappNoContactRevision" AS "noContactRevision"
    FROM "commerce"."CustomerPhone" cp JOIN "commerce"."Customer" c ON c."id"=cp."customerId"
    WHERE c."shopId"=${shopId} AND cp."endedAt" IS NULL ORDER BY cp."whatsappCanonicalPhone"
  `;
}

async function evidence(db: PrismaClient, shopId: string) {
  return db.whatsAppConsentEvidence.findMany({ where: { shopId },
    select: { eventId: true, decision: true, canonicalPhone: true, phoneConsentRevision: true } });
}

async function noEffects(db: PrismaClient, shopId: string) {
  assert.equal(await db.checkoutRecovery.count({ where: { shopId } }), 0);
  assert.equal(await db.billingOperation.count({ where: { shopId } }), 0);
}

// Distinct event IDs are deliberately not replay tests. Their physical transactions
// race for the same (shop, canonical phone) advisory lock, even for a new phone.
test("opposing simultaneous Woo GRANT/REVOKE events follow observation time, not commit order", {
  skip: !databaseUrl,
}, async () => {
  const ctx = await setup();
  const { db, shop, site, principal, service } = ctx;
  try {
    const grant = event(site, "race-grant", "GRANT", 90);
    const revoke = event(site, "race-revoke", "REVOKE", 60);
    const results = await Promise.allSettled([
      service.record(principal, grant), service.record(principal, revoke),
    ]);
    const firstRace = results[0]!;
    assert.equal(results[1]?.status, "fulfilled", "newest REVOKE must commit");
    if (firstRace.status === "rejected") {
      assert.ok(firstRace.reason instanceof WooConsentHttpError);
      assert.equal(firstRace.reason.code, "stale_consent_action");
    } else {
      assert.equal(firstRace.value.status, "recorded");
    }
    assert.equal((await phones(db, shop.id))[0]?.decision, "REVOKED");
    const facts = await evidence(db, shop.id);
    assert.equal(facts.filter(f => f.decision === "REVOKE").length, 1);
    assert.equal(facts.length, firstRace.status === "fulfilled" ? 2 : 1);
    // A successful event is an idempotent duplicate, while an earlier event
    // rejected after the REVOKE remains stale on retry.
    if (firstRace.status === "fulfilled") {
      assert.equal((await service.record(principal, grant)).status, "duplicate");
    } else {
      await assert.rejects(() => service.record(principal, grant), error =>
        error instanceof WooConsentHttpError && error.code === "stale_consent_action");
    }
    // Also race an earlier REVOKE with an explicitly later fresh GRANT. The
    // newer choice may re-authorise only when no independent STOP is present.
    const previous = event(site, "race-previous-revoke", "REVOKE", 40);
    const later = event(site, "race-later-grant", "GRANT", 20);
    const opposite = await Promise.allSettled([
      service.record(principal, previous), service.record(principal, later),
    ]);
    assert.equal(opposite[1]?.status, "fulfilled", "newest deliberate GRANT must commit");
    const priorRace = opposite[0]!;
    if (priorRace.status === "rejected") {
      assert.ok(priorRace.reason instanceof WooConsentHttpError);
      assert.equal(priorRace.reason.code, "stale_consent_action");
    }
    assert.equal((await phones(db, shop.id))[0]?.decision, "GRANTED");
    assert.equal((await evidence(db, shop.id)).filter(f => f.eventId === "race-later-grant").length, 1);
    await noEffects(db, shop.id);
  } finally { await db.$disconnect(); }
});

// Same source-and-recipient lock is held by a test transaction while an API
// consent request is in flight. STOP is written before the API can acquire it.
test("a CUSTOMER_STOP committed during an in-flight GRANT is never removed", {
  skip: !databaseUrl,
}, async () => {
  const { db, shop, site, principal, service } = await setup();
  try {
    await service.record(principal, event(site, "pre-stop-revoke", "REVOKE", 100));
    const target = (await phones(db, shop.id))[0]!;
    let inFlight!: ReturnType<typeof service.record>;
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(
        hashtext(${shop.id}), hashtext(${`phone:${phoneA}`}))`;
      inFlight = service.record(principal, event(site, "racing-regrant", "GRANT", 60));
      await tx.$executeRaw`
        UPDATE "commerce"."CustomerPhone" SET "whatsappNoContact"=TRUE,
          "whatsappNoContactReason"='CUSTOMER_STOP', "whatsappNoContactAt"=${now},
          "whatsappNoContactRevision"="whatsappNoContactRevision"+1
        WHERE "id"=${target.id}
      `;
    });
    const regrant = await inFlight;
    assert.equal(regrant.status, "recorded");
    const current = (await phones(db, shop.id))[0]!;
    assert.deepEqual([current.decision, current.noContact, current.reason,
      current.noContactRevision], ["GRANTED", true, "CUSTOMER_STOP", 1n]);
    assert.equal((await evidence(db, shop.id)).length, 2);
    await noEffects(db, shop.id);
  } finally { await db.$disconnect(); }
});

test("changed-number tabs never copy existing phone consent to a different recipient", {
  skip: !databaseUrl,
}, async () => {
  const { db, shop, site, principal, service } = await setup();
  try {
    await service.record(principal, event(site, "first-number-grant", "GRANT", 110));
    // A stale tab names the old phone while the Woo server has observed a new one.
    const stale = event(site, "old-tab-claims-new-phone", "GRANT", 80);
    stale.checkoutAction.serverObservedPhone = `+${phoneB}`;
    await assert.rejects(() => service.record(principal, stale), error =>
      error instanceof WooConsentHttpError && error.status === 422 && error.code === "recipient_mismatch");
    assert.equal((await phones(db, shop.id)).length, 1);
    // The new number is an independent recipient; a negative selection cannot
    // inherit the former number's GRANT.
    const newNumberRevoke = event(site, "new-number-revoke", "REVOKE", 70, phoneB);
    await service.record(principal, newNumberRevoke);
    assert.deepEqual((await phones(db, shop.id)).map(p => [p.canonical, p.decision]),
      [[phoneA, "GRANTED"], [phoneB, "REVOKED"]]);
    const changedRetry = event(site, "first-number-grant", "GRANT", 50, phoneB);
    await assert.rejects(() => service.record(principal, changedRetry), error =>
      error instanceof WooConsentHttpError && error.code === "consent_event_replay_conflict");
    const freshChoice = event(site, "new-number-grant", "GRANT", 40, phoneB);
    const [confirmed, delayed] = await Promise.allSettled([
      service.record(principal, freshChoice), service.record(principal, stale),
    ]);
    assert.equal(confirmed.status, "fulfilled");
    assert.equal(delayed.status, "rejected");
    assert.deepEqual((await phones(db, shop.id)).map(p => [p.canonical, p.decision]),
      [[phoneA, "GRANTED"], [phoneB, "GRANTED"]]);
    assert.equal((await evidence(db, shop.id)).length, 3);
    await noEffects(db, shop.id);
  } finally { await db.$disconnect(); }
});

test("real installation reconnect rotates the bearer, preserves duplicate evidence and denies revoked sessions", {
  skip: !databaseUrl,
}, async () => {
  const { db, shop, site, secret, installation, principal, service } = await setup();
  const verifier = new WooSiteVerifier({ mode: "public" });
  // This test replaces external site proof, not API installation or DB checks.
  verifier.verify = async () => {};
  const nextSecret = Buffer.alloc(32, 0x43);
  const connector = new WooInstallationConnectionService(db, verifier, () => now, () => nextSecret);
  const route = createWooConsentRoute({
    authenticator: new WooInstallationAuthenticator(db), service,
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  const server = createServer((req, res) => { void route.handle(req, res).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (credential: string, body: unknown) => fetch(`${origin}/v1/woocommerce/whatsapp-consent`, {
      method: "POST", headers: { "content-type": "application/json",
        "x-moda-installation-id": installation.id,
        authorization: `Bearer ${credential}` }, body: JSON.stringify(body),
    });
    const first = event(site, "pre-reconnect-grant", "GRANT", 100);
    assert.equal((await post(encodeSecret(secret), first)).status, 200);
    const reconnected = await connector.connect({
      site: canonicalizeWooSiteUrl(site, "public"), attemptId: randomUUID(),
      bootstrapSecret: Buffer.alloc(32, 0x44),
    });
    assert.equal(reconnected.connection, "RECONNECTED");
    assert.equal(reconnected.installationId, installation.id);
    assert.equal(reconnected.credentialVersion, 2);
    assert.equal((await post(encodeSecret(secret), event(site, "stale-install-grant", "GRANT", 80))).status, 401);
    await assert.rejects(() => service.record(principal, event(site, "stale-principal", "GRANT", 80)),
      WooUnauthenticatedError);
    const replay = await post(reconnected.credential, first);
    assert.deepEqual([(await replay.json() as { status: string }).status, replay.status], ["duplicate", 200]);
    assert.equal((await evidence(db, shop.id)).length, 1);
    assert.equal((await post(reconnected.credential, event(site, "new-session-revoke", "REVOKE", 60))).status, 200);
    assert.equal((await phones(db, shop.id))[0]?.decision, "REVOKED");
    await db.wooCommerceInstallation.update({ where: { id: installation.id },
      data: { status: "REVOKED", revokedAt: now } });
    assert.equal((await post(reconnected.credential, event(site, "revoked-session-grant", "GRANT", 40))).status, 401);
    assert.equal((await evidence(db, shop.id)).length, 2);
    await noEffects(db, shop.id);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.$disconnect();
  }
});
