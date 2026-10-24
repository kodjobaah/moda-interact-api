import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { WooConsentService } from "../../../../src/woocommerce/consent/service.js";
import { WooConsentHttpError } from "../../../../src/woocommerce/consent/contract.js";
import { WooInstallationAuthenticator } from "../../../../src/auth/woo-installation/authenticator.js";
import { encodeSecret, digestSecret } from "../../../../src/auth/woo-installation/credential.js";
import { createWooConsentRoute } from "../../../../src/woocommerce/consent/routes.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";

const url = process.env.WOO_CONSENT_TEST_DATABASE_URL;
const now = new Date("2026-10-22T12:05:00.000Z");
const timestamp = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();

// A standalone tenant without any Subscription or plan feature proves that
// the consent write does not depend on billing state or produce side effects.
test("v2 API accepts a passive grant without subscription, keeps evidence/STOP", {
  skip: !url,
}, async () => {
  if (!url) return;
  const db = new PrismaClient({ datasources: { db: { url } },
    log: [{ level: "query", emit: "event" }],
  });
  const observedSql: string[] = [];
  db.$on("query", event => observedSql.push(event.query));
  // Measurements run only in the disposable PostgreSQL suite; no production
  // metrics/logger is added by this task. Exclude setup SQL from each sample.
  const measure = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    const before = observedSql.length;
    const start = performance.now();
    const result = await operation();
    const statements = observedSql.slice(before);
    assert.equal(statements.some(query => /"billing"\.("Subscription"|"BillingPlan"|"BillingPlanFeature"|"Feature"|"ShopFeaturePreference")/i.test(query)), false,
      `${label} must never read billing/feature tables`);
    console.log(`ARCH-046-API-007 ${label}: sql_statements=${statements.length}, wall_ms=${(performance.now() - start).toFixed(2)}`);
    return result;
  };
  try {
    const site = `https://woo-thin-consent-${randomUUID()}.invalid`;
    const shop = await db.shop.create({ data: { domain: site, platform: "WOOCOMMERCE" } });
    const other = await db.shop.create({ data: {
      domain: `https://woo-other-${randomUUID()}.invalid`, platform: "WOOCOMMERCE",
    } });
    const secret = Buffer.alloc(32, 0x71);
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: site, credentialDigest: Uint8Array.from(digestSecret(secret)),
    } });
    const principal = { shopId: shop.id, installationId: installation.id,
      canonicalSiteUrl: site, credentialVersion: installation.credentialVersion };
    const service = new WooConsentService(db, () => now);
    const route = createWooConsentRoute({
      authenticator: new WooInstallationAuthenticator(db), service,
      logger: { info() {}, warn() {}, error() {} } as never,
    });
    const server = createServer((req, res) => { void route.handle(req, res).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const post = async (payload: unknown) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/woocommerce/whatsapp-consent`, {
        method: "POST", headers: { "content-type": "application/json",
          "x-moda-installation-id": installation.id,
          authorization: `Bearer ${encodeSecret(secret)}` }, body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    try {
      const grant = consentEvent({ eventId: "thin-v2-grant", occurredAt: timestamp(90) });
      const result = await measure("fresh_v2_grant", () => post(grant));
      assert.deepEqual([result.status, result.body.schemaVersion, result.body.consentRevision],
        [200, "woo.whatsapp-consent.v2", "1"]);
      const evidence = await db.whatsAppConsentEvidence.findUniqueOrThrow({
        where: { shopId_eventId: { shopId: shop.id, eventId: grant.eventId } },
      });
      assert.deepEqual([evidence.disclosureText, evidence.disclosureVersion,
        evidence.disclosureLocale, evidence.phoneConsentRevision],
        [grant.disclosure!.text, grant.disclosure!.version, grant.disclosure!.locale, 1n]);
      assert.equal(evidence.customerPhoneId.length > 0, true);
      assert.equal(evidence.canonicalPhone, grant.canonicalPhone);
      // API-006 must be able to resolve this exact proof tuple, not only the
      // unique (shopId,eventId) idempotency key. Any altered part fails.
      const proof = { shopId: shop.id, eventId: grant.eventId,
        canonicalPhone: grant.canonicalPhone, customerPhoneId: evidence.customerPhoneId,
        phoneConsentRevision: BigInt(result.body.consentRevision as string) };
      const retrieved = await db.whatsAppConsentEvidence.findFirst({ where: proof });
      assert.equal(retrieved?.id, evidence.id);
      assert.equal(await db.whatsAppConsentEvidence.findFirst({ where: {
        ...proof, phoneConsentRevision: proof.phoneConsentRevision + 1n,
      } }), null);
      assert.equal(await db.whatsAppConsentEvidence.findFirst({ where: {
        ...proof, shopId: other.id,
      } }), null);
      assert.equal((await measure("duplicate_v2_retry", () => post(grant))).body.status, "duplicate");
      assert.equal((await db.whatsAppConsentEvidence.count({ where: { shopId: shop.id } })), 1);
      assert.deepEqual([await db.subscription.count({ where: { shopId: shop.id } }),
        await db.checkoutRecovery.count({ where: { shopId: shop.id } }),
        await db.billingOperation.count({ where: { shopId: shop.id } })], [0, 0, 0]);
      assert.deepEqual([(await post({ ...grant, disclosure: { ...grant.disclosure!, text: "Modified" } })).status,
        (await post({ ...grant, schemaVersion: "woo.whatsapp-consent.v1" })).status], [409, 400]);
      const stopped = await db.customerPhone.findUniqueOrThrow({ where: { id: evidence.customerPhoneId } });
      await db.$executeRaw`UPDATE "commerce"."CustomerPhone" SET "whatsappNoContact"=TRUE,
        "whatsappNoContactReason"='CUSTOMER_STOP', "whatsappNoContactAt"=${now},
        "whatsappNoContactRevision"="whatsappNoContactRevision"+1 WHERE "id"=${stopped.id}`;
      const revoke = consentEvent({ eventId: "thin-v2-revoke", decision: "REVOKE",
        occurredAt: timestamp(70), disclosure: null });
      assert.equal((await measure("existing_v2_revoke", () => post(revoke))).body.decision, "REVOKE");
      const later = consentEvent({ eventId: "thin-v2-regrant", occurredAt: timestamp(50) });
      assert.equal((await measure("existing_v2_regrant", () => post(later))).body.consentRevision, "3");
      const phone = await db.customerPhone.findUniqueOrThrow({ where: { id: evidence.customerPhoneId } });
      assert.deepEqual([phone.whatsappConsentDecision, phone.whatsappNoContact,
        phone.whatsappNoContactReason], ["GRANTED", true, "CUSTOMER_STOP"]);
      assert.equal((await db.whatsAppConsentEvidence.count({ where: { shopId: shop.id } })), 3);
      const stale = consentEvent({ eventId: "thin-v2-old", occurredAt: timestamp(80) });
      assert.deepEqual([(await post(stale)).status, (await post(grant)).body.status], [409, "duplicate"]);
      // A different authenticated tenant/principal cannot write the first tenant.
      await assert.rejects(() => service.record({ ...principal, shopId: other.id },
        consentEvent({ eventId: "spoof", occurredAt: timestamp(40) })), /unauthorized/);
      // A changed recipient under a prior v2 ID is never silently accepted.
      assert.equal((await post({ ...grant, canonicalPhone: "447400123457" })).status, 409);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { await db.$disconnect(); }
});

test("v2 direct service rejects noncanonical recipient, freshness drift and time-order regressions", {
  skip: !url,
}, async () => {
  if (!url) return;
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const site = `https://woo-v2-errors-${randomUUID()}.invalid`;
    const shop = await db.shop.create({ data: { domain: site, platform: "WOOCOMMERCE" } });
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: site, credentialDigest: Uint8Array.from(digestSecret(Buffer.alloc(32, 0x72))),
    } });
    const principal = { shopId: shop.id, installationId: installation.id,
      canonicalSiteUrl: site, credentialVersion: installation.credentialVersion };
    const service = new WooConsentService(db, () => now);
    const rejected = (code: string) => (error: unknown) => error instanceof WooConsentHttpError && error.code === code;
    await assert.rejects(() => service.record(principal, consentEvent({ canonicalPhone: "44" })),
      rejected("recipient_mismatch"));
    await assert.rejects(() => service.record(principal, consentEvent({ occurredAt: timestamp(301) })),
      rejected("stale_consent_action"));
    await assert.rejects(() => service.record(principal, consentEvent({
      occurredAt: new Date(now.getTime() + 1000).toISOString(),
    })), rejected("stale_consent_action"));
    assert.equal(await db.whatsAppConsentEvidence.count({ where: { shopId: shop.id } }), 0);
  } finally { await db.$disconnect(); }
});

// Exercise the *actual* PostgreSQL rollback boundary without a production
// fault-injection hook. The test-only trigger aborts the evidence INSERT after
// CustomerPhone has been UPDATEd (or the new Customer/Phone created).
test("v2 evidence-insert failure rolls back consent update and newly created customer", {
  skip: !url,
}, async () => {
  if (!url) return;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const site = `https://woo-rollback-${randomUUID()}.invalid`;
  const triggerName = "arch046_api007_test_abort_evidence";
  const functionName = '"commerce"."arch046_api007_test_abort_evidence"';
  let functionCreated = false;
  let triggerCreated = false;
  try {
    const shop = await db.shop.create({ data: { domain: site, platform: "WOOCOMMERCE" } });
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: site,
      credentialDigest: Uint8Array.from(digestSecret(Buffer.alloc(32, 0x73))),
    } });
    const principal = { shopId: shop.id, installationId: installation.id,
      canonicalSiteUrl: site, credentialVersion: installation.credentialVersion };
    const service = new WooConsentService(db, () => now);
    const initial = consentEvent({ eventId: "thin-v2-rollback-initial", occurredAt: timestamp(100) });
    await service.record(principal, initial);
    const before = await db.customerPhone.findFirstOrThrow({
      where: { customer: { shopId: shop.id }, whatsappCanonicalPhone: initial.canonicalPhone },
    });
    const beforeEvidence = await db.whatsAppConsentEvidence.count({ where: { shopId: shop.id } });
    const beforeCustomers = await db.customer.count({ where: { shopId: shop.id } });
    const beforePhones = await db.customerPhone.count({ where: { customer: { shopId: shop.id } } });

    // This function exists exclusively in the disposable test database. It
    // fails selected event IDs, never any unrelated application write.
    await db.$executeRawUnsafe(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."eventId" LIKE 'thin-v2-rollback-fail-%' THEN
          RAISE EXCEPTION 'arch046_api007_evidence_insertion_injected_failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    functionCreated = true;
    await db.$executeRawUnsafe(`
      CREATE TRIGGER ${triggerName} BEFORE INSERT
      ON "commerce"."WhatsAppConsentEvidence"
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()
    `);
    triggerCreated = true;

    const failedRevoke = consentEvent({ eventId: "thin-v2-rollback-fail-revoke",
      occurredAt: timestamp(80), decision: "REVOKE", disclosure: null });
    await assert.rejects(() => service.record(principal, failedRevoke),
      /arch046_api007_evidence_insertion_injected_failure/);
    const after = await db.customerPhone.findUniqueOrThrow({ where: { id: before.id } });
    assert.deepEqual({ decision: after.whatsappConsentDecision,
      revision: after.whatsappConsentRevision,
      sequence: after.whatsappConsentDecisionSequence,
      observed: after.whatsappConsentProviderObservedAt,
      verified: after.whatsappConsentVerifiedAt,
      source: after.whatsappConsentSource },
    { decision: before.whatsappConsentDecision,
      revision: before.whatsappConsentRevision,
      sequence: before.whatsappConsentDecisionSequence,
      observed: before.whatsappConsentProviderObservedAt,
      verified: before.whatsappConsentVerifiedAt,
      source: before.whatsappConsentSource });
    assert.equal(await db.whatsAppConsentEvidence.count({ where: { shopId: shop.id } }), beforeEvidence);
    assert.equal(await db.whatsAppConsentEvidence.findFirst({ where: {
      shopId: shop.id, eventId: failedRevoke.eventId,
    } }), null);

    const newPhone = "447400123459";
    const failedNew = consentEvent({ eventId: "thin-v2-rollback-fail-new-phone",
      occurredAt: timestamp(70), canonicalPhone: newPhone });
    await assert.rejects(() => service.record(principal, failedNew),
      /arch046_api007_evidence_insertion_injected_failure/);
    assert.equal(await db.customer.count({ where: { shopId: shop.id } }), beforeCustomers);
    assert.equal(await db.customerPhone.count({ where: { customer: { shopId: shop.id } } }), beforePhones);
    assert.equal(await db.whatsAppConsentEvidence.count({ where: { shopId: shop.id } }), beforeEvidence);
    assert.equal(await db.customerPhone.findFirst({ where: {
      customer: { shopId: shop.id }, whatsappCanonicalPhone: newPhone,
    } }), null);
  } finally {
    // Cleanup is mandatory even when an assertion fails, so the other suites
    // do not inherit the deliberate database failure mode.
    if (triggerCreated) await db.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${triggerName} ON "commerce"."WhatsAppConsentEvidence"`);
    if (functionCreated) await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await db.$disconnect();
  }
});
