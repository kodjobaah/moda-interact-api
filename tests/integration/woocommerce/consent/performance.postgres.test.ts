import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { digestSecret } from "../../../../src/auth/woo-installation/credential.js";
import { WooConsentService } from "../../../../src/woocommerce/consent/service.js";
import type { WooConsentEvent } from "../../../../src/woocommerce/consent/contract.js";

const url = process.env.WOO_CONSENT_TEST_DATABASE_URL;
const baseline = process.env.ARCH046_CONSENT_BENCH_VERSION === "v1";
const comparison = process.env.ARCH046_CONSENT_BENCH_VERSION === "v2" || baseline;
const now = new Date("2026-10-22T12:10:00.000Z");
const at = (secondsBeforeNow: number) => new Date(now.getTime() - secondsBeforeNow * 1000).toISOString();

type TransactionTime = { ms: number; outcome: "commit" | "rollback" };

// Read-only instrumentation of the *test service's* Prisma transaction call.
// It excludes HTTP/auth/setup and does not modify production service logic.
function timedDatabase(db: PrismaClient, timings: TransactionTime[]): Pick<PrismaClient, "$transaction"> {
  return { $transaction: (async <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number }): Promise<T> => {
    const started = performance.now();
    try {
      const result = await db.$transaction(fn, options);
      timings.push({ ms: performance.now() - started, outcome: "commit" });
      return result;
    } catch (error) {
      timings.push({ ms: performance.now() - started, outcome: "rollback" });
      throw error;
    }
  }) as PrismaClient["$transaction"] };
}

// The SAME benchmark source runs against two isolated code revisions. The v1
// source is obtained from the pinned pre-API-007 Git commit by the disposable
// PostgreSQL runner; the v2 source is this implementation. This legacy event
// shape is a test-only comparison fixture, not a production compatibility path.
function consentEvent(version: "v1" | "v2", site: string, id: string,
  decision: "GRANT" | "REVOKE", secondsBeforeNow: number): WooConsentEvent {
  const fields = { eventId: id, decision, canonicalPhone: "447400123456" };
  if (version === "v1") {
    return {
      ...fields, schemaVersion: "woo.whatsapp-consent.v1", purpose: "WHATSAPP_CHECKOUT_RECOVERY",
      checkoutAction: { checkoutKey: `bench-${id}`, checkoutMode: "CLASSIC", source: "WOO_CHECKOUT_SERVER_HOOK",
        fieldId: "moda/whatsapp-checkout-recovery", selection: decision === "GRANT" ? "CHECKED" : "UNCHECKED",
        userInitiated: true, nonceVerified: true, sessionVerified: true, serverObservedPhone: "+447400123456",
        verifiedCountryCode: "GB", occurredAt: at(secondsBeforeNow) },
      disclosure: decision === "GRANT" ? {
        version: "moda.woo.whatsapp-recovery-marketing.v1", locale: "en-GB", merchantSiteUrl: site,
        text: `Allow ${site} to send WhatsApp abandoned-basket marketing reminders.`,
      } : null,
    } as unknown as WooConsentEvent;
  }
  return { ...fields, schemaVersion: "woo.whatsapp-consent.v2",
    occurredAt: at(secondsBeforeNow),
    disclosure: decision === "GRANT" ? { version: "moda.woo.whatsapp-recovery-marketing.v3",
      locale: "en-GB", text: "Send me WhatsApp shopping updates, reminders and offers." } : null,
  } as WooConsentEvent;
}

test("API-007 comparable pre-change/v2 SQL, transaction duration and failure outcomes", {
  skip: !url || !comparison,
}, async () => {
  if (!url || !comparison) return;
  const version = baseline ? "v1" : "v2";
  const db = new PrismaClient({ datasources: { db: { url } },
    log: [{ level: "query", emit: "event" }],
  });
  const sql: string[] = [];
  db.$on("query", query => sql.push(query.query));
  const timings: TransactionTime[] = [];
  const service = new WooConsentService(timedDatabase(db, timings), () => now);
  try {
    // Equal setup for v1 and v2: active recovery plan/feature and one Woo
    // installation; setup queries are excluded from each measured operation.
    const feature = await db.feature.findUniqueOrThrow({ where: { key: "checkout_recovery" } });
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `arch046-comparison-${randomUUID()}`, name: "API-007 benchmark", kind: "FREE",
    } });
    await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id, enabled: true } });
    const site = `https://arch046-bench-${randomUUID()}.invalid`;
    const shop = await db.shop.create({ data: { domain: site, platform: "WOOCOMMERCE", onboardingCompleted: true } });
    await db.subscription.create({ data: { shopId: shop.id, planId: plan.id, status: "ACTIVE" } });
    const installed = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: site,
      credentialDigest: Uint8Array.from(digestSecret(Buffer.alloc(32, 0x75))),
    } });
    const principal = { shopId: shop.id, installationId: installed.id,
      canonicalSiteUrl: site, credentialVersion: installed.credentialVersion };
    const prefix = randomUUID().slice(0, 8);
    const initial = consentEvent(version, site, `${prefix}-fresh`, "GRANT", 100);
    const existing = consentEvent(version, site, `${prefix}-existing`, "GRANT", 80);
    const revoke = consentEvent(version, site, `${prefix}-revoke`, "REVOKE", 60);
    const stale = consentEvent(version, site, `${prefix}-stale`, "GRANT", 90);

    const measure = async (scenario: string, event: WooConsentEvent, expected: "recorded" | "duplicate" | "rejected") => {
      const sqlBefore = sql.length;
      const transactionBefore = timings.length;
      const started = performance.now();
      let outcome = "rejected";
      let rejection: unknown;
      try {
        const result = await service.record(principal, event);
        outcome = result.status;
      } catch (error) { rejection = error; }
      const wallMs = performance.now() - started;
      const statementSql = sql.slice(sqlBefore);
      const transactionTimes = timings.slice(transactionBefore);
      assert.equal(transactionTimes.length, 1, `${scenario} must have one transaction`);
      const tx = transactionTimes[0]!;
      assert.equal(outcome, expected);
      if (expected === "rejected") {
        assert.ok(rejection instanceof Error);
        assert.equal(tx.outcome, "rollback");
      } else {
        assert.equal(tx.outcome, "commit");
      }
      // Use the same method/query observer for both versions; a baseline GRANT
      // is expected to read billing while v2 must not.
      const billingRead = statementSql.some(query => /"billing"\."(Subscription|BillingPlan|BillingPlanFeature|Feature|ShopFeaturePreference)"/i.test(query));
      if (version === "v2") assert.equal(billingRead, false);
      console.log(`ARCH046_CONSENT_COMPARISON ${JSON.stringify({
        version, scenario, sql_statements: statementSql.length,
        transaction_client_ms: Number(tx.ms.toFixed(2)),
        scenario_wall_ms: Number(wallMs.toFixed(2)), outcome,
        billing_read: billingRead,
      })}`);
    };

    await measure("fresh_GRANT", initial, "recorded");
    await measure("existing_GRANT", existing, "recorded");
    await measure("REVOKE", revoke, "recorded");
    await measure("duplicate_retry", initial, "duplicate");
    await measure("stale_GRANT_failure", stale, "rejected");

    // Deliberately abort the evidence INSERT after the existing phone update.
    // Both revisions of the consent service must roll the whole transaction
    // back. Trigger setup/teardown is outside the measured SQL window.
    const functionName = '"commerce"."arch046_api007_bench_abort_evidence"';
    const triggerName = "arch046_api007_bench_abort_evidence";
    await db.$executeRawUnsafe(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."eventId" LIKE 'bench-fail-%' THEN
          RAISE EXCEPTION 'arch046_api007_benchmark_injected_failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    try {
      await db.$executeRawUnsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT
        ON "commerce"."WhatsAppConsentEvidence"
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      try {
        const failed = consentEvent(version, site, `bench-fail-${prefix}`, "GRANT", 40);
        await measure("injected_evidence_failure", failed, "rejected");
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName}
          ON "commerce"."WhatsAppConsentEvidence"`);
      }
    } finally {
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    assert.equal(await db.whatsAppConsentEvidence.count({ where: { shopId: shop.id } }), 3);
    const unchanged = await db.customerPhone.findFirstOrThrow({ where: {
      customer: { shopId: shop.id }, whatsappCanonicalPhone: "447400123456",
    } });
    assert.deepEqual([unchanged.whatsappConsentDecision, unchanged.whatsappConsentRevision], ["REVOKED", 3n]);
  } finally { await db.$disconnect(); }
});
