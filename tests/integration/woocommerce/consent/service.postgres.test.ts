import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { WooConsentService } from "../../../../src/woocommerce/consent/service.js";
import { WooConsentHttpError } from "../../../../src/woocommerce/consent/contract.js";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { digestSecret, encodeSecret } from "../../../../src/auth/woo-installation/credential.js";
import { createWooConsentRoute } from "../../../../src/woocommerce/consent/routes.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";

const url = process.env.WOO_CONSENT_TEST_DATABASE_URL;
const digits = "447400123456";
const rejected = (code: string) => (error: unknown) =>
  error instanceof WooConsentHttpError && error.code === code;

test("authenticated Woo consent: durable phone/evidence, ordering, STOP and tenant isolation", {
  skip: !url,
}, async () => {
  if (!url) return;
  const db = new PrismaClient({ datasources: { db: { url } } });
  let clock = new Date("2026-10-22T12:02:00.000Z");
  const service = new WooConsentService(db, () => clock);
  const tick = () => { clock = new Date(clock.getTime() + 10_000); return new Date(clock.getTime() - 1_000).toISOString(); };
  const captured = (site: string, eventId: string, decision: "GRANT" | "REVOKE", at: string, phone = digits) => {
    const source = consentEvent();
    return consentEvent({ eventId, decision, canonicalPhone: phone,
      checkoutAction: { ...source.checkoutAction, occurredAt: at, serverObservedPhone: `+${phone}`,
        selection: decision === "GRANT" ? "CHECKED" : "UNCHECKED" },
      disclosure: decision === "GRANT" ? { ...source.disclosure!, merchantSiteUrl: site,
        text: `Allow ${site} to send WhatsApp abandoned-basket marketing reminders.` } : null });
  };
  async function current(shopId: string, phone = digits) {
    return db.$queryRaw<Array<{ id: string; customerId: string; whatsappConsentDecision: string;
      whatsappConsentRevision: bigint; whatsappConsentDecisionSequence: bigint;
      whatsappNoContact: boolean; whatsappNoContactReason: string | null }>>`
      SELECT cp."id", cp."customerId", cp."whatsappConsentDecision"::text,
        cp."whatsappConsentRevision", cp."whatsappConsentDecisionSequence",
        cp."whatsappNoContact", cp."whatsappNoContactReason"::text
      FROM "commerce"."CustomerPhone" cp JOIN "commerce"."Customer" c ON c."id"=cp."customerId"
      WHERE c."shopId"=${shopId} AND cp."whatsappCanonicalPhone"=${phone} AND cp."endedAt" IS NULL
      ORDER BY cp."id"
    `;
  }
  async function evidence(shopId: string) {
    return db.$queryRaw<Array<{ eventId: string; decision: string; phoneConsentRevision: bigint }>>`
      SELECT "eventId", "decision"::text, "phoneConsentRevision"
      FROM "commerce"."WhatsAppConsentEvidence" WHERE "shopId"=${shopId} ORDER BY "recordedAt", "eventId"
    `;
  }
  try {
    // This disposable database must be migration-current; no db-push shortcut.
    // ARCH-017 seeds checkout_recovery; the canonical feature-ID migration preserves it.
    // Reuse the migrated feature rather than inserting a duplicate unique key.
    const feature = await db.feature.findUniqueOrThrow({ where: { key: "checkout_recovery" } });
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `consent-${randomUUID()}`, name: "Consent Integration", kind: "FREE",
    } });
    await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id, enabled: true } });
    const shop = await db.shop.create({ data: { domain: "https://woo-consent-one.invalid", platform: "WOOCOMMERCE" } });
    const other = await db.shop.create({ data: { domain: "https://woo-consent-two.invalid", platform: "WOOCOMMERCE" } });
    await db.subscription.createMany({ data: [
      { shopId: shop.id, planId: plan.id, status: "ACTIVE" },
      { shopId: other.id, planId: plan.id, status: "ACTIVE" },
    ] });
    const credential = Buffer.alloc(32, 0x59);
    const otherCredential = Buffer.alloc(32, 0x5a);
    const installed = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain, credentialDigest: Uint8Array.from(digestSecret(credential)),
    } });
    const otherInstalled = await db.wooCommerceInstallation.create({ data: {
      shopId: other.id, canonicalSiteUrl: other.domain, credentialDigest: Uint8Array.from(digestSecret(otherCredential)),
    } });
    const principal = { shopId: shop.id, installationId: installed.id,
      canonicalSiteUrl: shop.domain, credentialVersion: installed.credentialVersion };
    const otherPrincipal = { shopId: other.id, installationId: otherInstalled.id,
      canonicalSiteUrl: other.domain, credentialVersion: otherInstalled.credentialVersion };
    const initial = captured(shop.domain, "grant-001", "GRANT", tick());
    // Shop-language copy can be brief and need not embed the
    // canonical site URL or an English word such as "WhatsApp".
    initial.disclosure = { ...initial.disclosure!,
      version: "moda.woo.whatsapp-recovery-marketing.v3", locale: "fr-FR",
      text: "Envoyez-moi des actualités, des rappels et des offres." };
    await assert.rejects(() => service.record(principal, { ...initial, eventId: "wrong-merchant-site",
      disclosure: { ...initial.disclosure!, merchantSiteUrl: other.domain },
    }), rejected("consent_disclosure_invalid"));
    assert.equal((await evidence(shop.id)).length, 0);
    const first = await service.record(principal, initial);
    assert.deepEqual([first.status, first.consentRevision, first.decisionSequence], ["recorded", "1", "1"]);
    assert.deepEqual([...(await current(shop.id)).map(row => row.whatsappConsentDecision)], ["GRANTED"]);
    assert.equal((await evidence(shop.id)).length, 1);
    const storedDisclosure = await db.$queryRaw<Array<{ disclosureText: string | null;
      disclosureVersion: string | null; disclosureLocale: string | null }>>`
      SELECT "disclosureText", "disclosureVersion", "disclosureLocale"
      FROM "commerce"."WhatsAppConsentEvidence"
      WHERE "shopId"=${shop.id} AND "eventId"=${initial.eventId}
    `;
    assert.deepEqual(storedDisclosure, [{ disclosureText: initial.disclosure!.text,
      disclosureVersion: initial.disclosure!.version, disclosureLocale: "fr-FR" }]);
    assert.equal(await db.checkoutRecovery.count({ where: { shopId: shop.id } }), 0);

    // Lost ACK/repeated identical request, including simultaneous two-tab retries.
    const [repeatA, repeatB] = await Promise.all([
      service.record(principal, initial), service.record(principal, initial),
    ]);
    assert.deepEqual([repeatA.status, repeatB.status], ["duplicate", "duplicate"]);
    // Changing the disclosure (or phone) under the same eventId must fail,
    // even though both texts would independently pass shape validation.
    await assert.rejects(() => service.record(principal, {
      ...initial, disclosure: { ...initial.disclosure!,
        text: `Allow ${shop.domain} to send WhatsApp abandoned-checkout marketing messages.` },
    }), rejected("consent_event_replay_conflict"));
    await assert.rejects(() => service.record(principal, {
      ...initial, canonicalPhone: "447400123458",
    }), rejected("recipient_mismatch"));
    assert.equal((await evidence(shop.id)).length, 1);

    // A withdrawal can succeed with the entitlement disabled, but not an old grant.
    await db.billingPlanFeature.update({ where: { planId_featureId: { planId: plan.id, featureId: feature.id } },
      data: { enabled: false } });
    const withdraw = captured(shop.domain, "revoke-002", "REVOKE", tick());
    const second = await service.record(principal, withdraw);
    assert.equal(second.consentRevision, "2");
    await assert.rejects(() => service.record(principal, captured(shop.domain, "grant-disabled", "GRANT", tick())),
      rejected("checkout_recovery_unavailable"));
    await db.billingPlanFeature.update({ where: { planId_featureId: { planId: plan.id, featureId: feature.id } },
      data: { enabled: true } });
    await assert.rejects(() => service.record(principal, captured(shop.domain, "late-grant", "GRANT",
      initial.checkoutAction.occurredAt)), rejected("stale_consent_action"));
    assert.equal((await service.record(principal, initial)).status, "duplicate");
    assert.equal((await current(shop.id))[0]?.whatsappConsentDecision, "REVOKED");

    // STOP is a stronger, independent no-contact prohibition: no checkbox may clear it.
    const phoneId = (await current(shop.id))[0]!.id;
    await db.$executeRaw`
      UPDATE "commerce"."CustomerPhone" SET "whatsappNoContact"=TRUE,
        "whatsappNoContactReason"='CUSTOMER_STOP', "whatsappNoContactAt"=${clock},
        "whatsappNoContactRevision"="whatsappNoContactRevision"+1 WHERE "id"=${phoneId}
    `;
    const regrant = await service.record(principal, captured(shop.domain, "regrant-003", "GRANT", tick()));
    assert.equal(regrant.consentRevision, "3");
    assert.deepEqual([(await current(shop.id))[0]?.whatsappNoContact,
      (await current(shop.id))[0]?.whatsappNoContactReason], [true, "CUSTOMER_STOP"]);
    assert.equal((await evidence(shop.id)).length, 3);
    assert.equal(await db.checkoutRecovery.count({ where: { shopId: shop.id } }), 0);
    assert.equal(await db.billingOperation.count({ where: { shopId: shop.id } }), 0);

    // A phone in another merchant never resolves to the first merchant's Customer.
    const separate = await service.record(otherPrincipal, captured(other.domain, "other-grant", "GRANT", tick()));
    assert.equal(separate.consentRevision, "1");
    assert.notEqual((await current(shop.id))[0]?.customerId, (await current(other.id))[0]?.customerId);
    assert.equal((await current(other.id))[0]?.whatsappNoContact, false);

    // Exercise real bearer authentication and POST -> DB commit against the same
    // disposable migrated PostgreSQL, not a mocked authenticator/database.
    const httpRoute = createWooConsentRoute({
      authenticator: new WooInstallationAuthenticator(db), service,
      logger: { info() {}, warn() {}, error() {} } as never,
    });
    const httpServer = createServer((req, res) => {
      void httpRoute.handle(req, res).then(handled => {
        if (!handled) { res.writeHead(404); res.end(); }
      });
    });
    await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
      const post = (body: unknown, headers: Record<string, string> = {}) => fetch(
        `${origin}/v1/woocommerce/whatsapp-consent`, {
          method: "POST", headers: { "content-type": "application/json",
            "x-moda-installation-id": otherInstalled.id,
            authorization: `Bearer ${encodeSecret(otherCredential)}`, ...headers },
          body: JSON.stringify(body),
        },
      );
      const existingCustomer = randomUUID();
      const existingPhone = randomUUID();
      const matchedDigits = "12133734253";
      // Raw fixture inserts must provide updatedAt, which Prisma normally populates.
      await db.$executeRaw`INSERT INTO "commerce"."Customer" ("id","shopId","phone","updatedAt")
        VALUES (${existingCustomer}, ${other.id}, ${`+${matchedDigits}`}, CURRENT_TIMESTAMP)`;
      await db.$executeRaw`INSERT INTO "commerce"."CustomerPhone"
        ("id","customerId","phone","whatsappCanonicalPhone","updatedAt")
        VALUES (${existingPhone}, ${existingCustomer}, ${`+${matchedDigits}`}, ${matchedDigits}, CURRENT_TIMESTAMP)`;
      assert.equal((await current(other.id, matchedDigits))[0]?.whatsappConsentDecision, "UNKNOWN");
      const verified = captured(other.domain, "signed-post-001", "GRANT", tick(), matchedDigits);
      const verifiedReply = await post({ ...verified, checkoutAction: {
        ...verified.checkoutAction, verifiedCountryCode: "US",
      } });
      assert.equal(verifiedReply.status, 200);
      assert.deepEqual([(await verifiedReply.json() as { status: string }).status,
        (await current(other.id, matchedDigits))[0]?.customerId], ["recorded", existingCustomer]);
      assert.equal((await current(other.id, matchedDigits))[0]?.whatsappConsentDecision, "GRANTED");
      const badAttestation = await post({ ...verified, eventId: "unsigned-choice-002",
        checkoutAction: { ...verified.checkoutAction, nonceVerified: false } });
      assert.equal(badAttestation.status, 400);
      const missingBearer = await post(verified, { authorization: "Bearer invalid" });
      assert.equal(missingBearer.status, 401);
      assert.equal((await evidence(other.id)).length, 2);
      assert.equal(await db.checkoutRecovery.count({ where: { shopId: other.id } }), 0);
      assert.equal(await db.billingOperation.count({ where: { shopId: other.id } }), 0);
    } finally {
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    }

    // Rejection of ambiguous active matches never coalesces multiple Customers.
    const duplicateDigits = "447400123457";
    for (let n = 0; n < 2; n++) {
      const customerId = randomUUID();
      await db.$executeRaw`INSERT INTO "commerce"."Customer" ("id","shopId","phone","updatedAt")
        VALUES (${customerId}, ${shop.id}, ${`+${duplicateDigits}`}, CURRENT_TIMESTAMP)`;
      await db.$executeRaw`INSERT INTO "commerce"."CustomerPhone"
        ("id","customerId","phone","whatsappCanonicalPhone","updatedAt")
        VALUES (${randomUUID()}, ${customerId}, ${`+${duplicateDigits}`}, ${duplicateDigits}, CURRENT_TIMESTAMP)`;
    }
    await assert.rejects(() => service.record(principal,
      captured(shop.domain, "ambiguous-004", "GRANT", tick(), duplicateDigits)),
      rejected("ambiguous_customer_phone"));
    assert.equal((await evidence(shop.id)).length, 3);

    // Credential rotation and revocation must be reverified inside the transaction.
    await db.wooCommerceInstallation.update({ where: { id: installed.id }, data: { credentialVersion: { increment: 1 } } });
    await assert.rejects(() => service.record(principal, captured(shop.domain, "old-credential", "GRANT", tick())),
      WooUnauthenticatedError);
    const rotated = { ...principal, credentialVersion: principal.credentialVersion + 1 };
    await db.wooCommerceInstallation.update({ where: { id: installed.id }, data: { status: "REVOKED", revokedAt: clock } });
    await assert.rejects(() => service.record(rotated, captured(shop.domain, "revoked-install", "GRANT", tick())),
      WooUnauthenticatedError);
  } finally { await db.$disconnect(); }
});
