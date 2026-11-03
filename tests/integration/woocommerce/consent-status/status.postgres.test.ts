import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { WooInstallationAuthenticator } from "../../../../src/auth/woo-installation/authenticator.js";
import { encodeSecret, digestSecret } from "../../../../src/auth/woo-installation/credential.js";
import { WooConsentStatusService } from "../../../../src/woocommerce/consent-status/service.js";
import { WOO_CONSENT_STATUS_PATH, WOO_CONSENT_STATUS_VERSION,
  type WooConsentStatusProbe } from "../../../../src/woocommerce/consent-status/contract.js";
import { createWooRoutes } from "../../../../src/composition/woocommerce.js";
import { composeApiRoutes } from "../../../../src/composition/routes.js";
import type { RuntimeConfig } from "../../../../src/runtime-config.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";

const url = process.env.WOO_CONSENT_TEST_DATABASE_URL;

function percentile(measurements: readonly number[], fraction: number): number {
  const sorted = [...measurements].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

/** No guessed latency SLA: report measured, warm timings from the disposable DB. */
function rounded(value: number): number { return Math.round(value * 100) / 100; }


test("real HTTP route: one joined status read checks GRANT, REVOKE and installation identity", {
  skip: !url,
}, async () => {
  if (!url) return;
  const database = new PrismaClient({ datasources: { db: { url } },
    log: [{ level: "query", emit: "event" }],
  });
  const sql: string[] = [];
  const queryTimings: { sql: string; durationMs: number }[] = [];
  database.$on("query", event => {
    sql.push(event.query);
    queryTimings.push({ sql: event.query, durationMs: event.duration });
  });
  const logger = { info() {}, warn() {}, error() {} } as never;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const name = randomUUID();
    const shop = await database.shop.create({ data: {
      domain: `https://woo-status-${name}.invalid`, platform: "WOOCOMMERCE",
    } });
    const other = await database.shop.create({ data: {
      domain: `https://woo-status-other-${name}.invalid`, platform: "WOOCOMMERCE",
    } });
    const secret = Buffer.alloc(32, 0x41);
    const otherSecret = Buffer.alloc(32, 0x42);
    const installation = await database.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain,
      credentialDigest: Uint8Array.from(digestSecret(secret)),
    } });
    const otherInstallation = await database.wooCommerceInstallation.create({ data: {
      shopId: other.id, canonicalSiteUrl: other.domain,
      credentialDigest: Uint8Array.from(digestSecret(otherSecret)),
    } });
    const authenticator = new WooInstallationAuthenticator(database);
    // This is the real composition factory, not a standalone test-only route.
    let queued = 0;
    const publisher = { async publish(): Promise<never> {
      queued++;
      throw new Error("Consent status must not publish jobs");
    } };
    const effects = () => Promise.all([
      database.checkoutRecovery.findMany({ orderBy: { id: "asc" } }),
      database.recoveryOutreachAttempt.findMany({ orderBy: { id: "asc" } }),
      database.merchantConversationSendCommand.findMany({ orderBy: { id: "asc" } }),
      database.conversationMessage.findMany({ orderBy: { id: "asc" } }),
      database.subscription.findMany({ orderBy: { id: "asc" } }),
      database.recoveryCreditPurchase.findMany({ orderBy: { id: "asc" } }),
      database.recoveryCreditRefund.findMany({ orderBy: { id: "asc" } }),
      database.usageReservation.findMany({ orderBy: { id: "asc" } }),
      database.promotionalCreditGrant.findMany({ orderBy: { id: "asc" } }),
    ]);
    const effectsBefore = await effects();
    const woo = createWooRoutes({ prisma: database, authenticator,
      checkoutPublisher: publisher, orderPublisher: publisher,
      config: { woocommerceConnectionMode: "local-development" } as RuntimeConfig,
      logger });
    const routes = composeApiRoutes({ wooBillingWebhook: woo.billingWebhook,
      wooConsent: woo.consent, wooConsentStatus: woo.consentStatus,
      merchant: [], billing: [], wooInstallation: woo.installation });
    server = createServer((request, response) => {
      void (async () => {
        for (const route of routes) if (await route.handle(request, response)) return;
        response.writeHead(404); response.end();
      })();
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (process.env.MODA_WOO_SOURCE_ROOT) {
      const fixturePhone = "447400123459";
      const { stdout } = await promisify(execFile)("php", [
        fileURLToPath(new URL("../../../contracts/woocommerce/consent-returning-checkout.php", import.meta.url)),
      ], {
        timeout: 20_000,
        env: { ...process.env, MODA_CONSENT_FIXTURE: JSON.stringify({ origin, phone: fixturePhone, installation: {
          schemaVersion: 1, installationId: installation.id, shopId: shop.id, canonicalSiteUrl: shop.domain,
          credential: encodeSecret(secret), credentialVersion: installation.credentialVersion,
          connectedAt: new Date().toISOString(),
        } }) },
      });
      const checkout = JSON.parse(stdout) as { confirmed: boolean; eventId: string };
      assert.equal(checkout.confirmed, true);
      const checkoutEvidence = await database.whatsAppConsentEvidence.findMany({
        where: { shopId: shop.id, canonicalPhone: fixturePhone },
      });
      assert.deepEqual(checkoutEvidence.map(row => [row.eventId, row.decision]), [[checkout.eventId, "GRANT"]]);
    }
    const request = async (path: string, payload: unknown, useOther = false) => {
      const queryStart = sql.length;
      const response = await fetch(`${origin}${path}`, { method: "POST",
        headers: { "content-type": "application/json",
          "x-moda-installation-id": useOther ? otherInstallation.id : installation.id,
          authorization: `Bearer ${encodeSecret(useOther ? otherSecret : secret)}` },
        body: JSON.stringify(payload),
      });
      if (path === WOO_CONSENT_STATUS_PATH) {
        assert.ok(sql.slice(queryStart).every(statement => /^\s*SELECT\b/i.test(statement)),
          "status must issue only SELECT statements");
      }
      return { status: response.status, body: await response.json() as Record<string, unknown>,
        cache: response.headers.get("cache-control") };
    };
    const phone = "447400123456";
    const baseTime = Date.now();
    const grant = consentEvent({ eventId: `status-integration-${name.slice(0, 8)}`, canonicalPhone: phone,
      occurredAt: new Date(baseTime - 120_000).toISOString() });
    const record = await request("/v1/woocommerce/whatsapp-consent", grant);
    assert.deepEqual([record.status, record.body.status], [200, "recorded"]);
    const probe: WooConsentStatusProbe = { schemaVersion: WOO_CONSENT_STATUS_VERSION,
      canonicalPhone: phone, grantEventId: grant.eventId };
    const status = async (input: unknown = probe, useOther = false) =>
      request(WOO_CONSENT_STATUS_PATH, input, useOther);
    const evidence = await database.whatsAppConsentEvidence.findUniqueOrThrow({
      where: { shopId_eventId: { shopId: shop.id, eventId: grant.eventId } },
    });
    const replay = await request("/v1/woocommerce/whatsapp-consent", grant);
    assert.equal(replay.body.status, "duplicate");
    assert.deepEqual(await database.whatsAppConsentEvidence.findUniqueOrThrow({
      where: { shopId_eventId: { shopId: shop.id, eventId: grant.eventId } },
    }), evidence);
    await assert.rejects(database.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: `https://alternate-${name}.invalid`,
      credentialDigest: Uint8Array.from(digestSecret(otherSecret)),
    } }), error => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002");
    assert.equal((await new WooConsentStatusService(database).read({
      shopId: shop.id, installationId: otherInstallation.id,
      canonicalSiteUrl: shop.domain, credentialVersion: installation.credentialVersion,
    }, probe)).state, "UNVERIFIED");
    // Snapshot durable state outside the measured read. Status must not mutate it.
    const beforeEvidence = await database.whatsAppConsentEvidence.findMany({ where: { shopId: shop.id },
      orderBy: { eventId: "asc" } });
    const beforePhones = await database.customerPhone.findMany({ where: { customer: { shopId: shop.id } },
      orderBy: { id: "asc" } });
    const beforeRecoveries = await database.checkoutRecovery.count({ where: { shopId: shop.id } });
    const before = sql.length;
    const confirmed = await status();
    const queries = sql.slice(before);
    assert.deepEqual([confirmed.status, confirmed.body, confirmed.cache],
      [200, { schemaVersion: WOO_CONSENT_STATUS_VERSION, state: "CONFIRMED_GRANTED" }, "no-store"]);
    assert.equal(queries.filter(query => query.includes("WhatsAppConsentEvidence")).length, 1,
      "exactly one indexed evidence/current-state SELECT");
    assert.equal(queries.some(query => /BEGIN|COMMIT|ROLLBACK|Subscription|FeaturePreference/i.test(query)), false,
      "no transaction, subscription or feature queries on a status read");
    assert.equal(queries.some(query => /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(query)),
      false, "the status route must perform no database writes");
    const observedQueryTimings = queryTimings.slice(before);
    assert.equal(observedQueryTimings.length, queries.length);
    assert.equal(observedQueryTimings.every(query => Number.isFinite(query.durationMs) && query.durationMs >= 0), true);
    // Warm the connection before comparing timings. Keep exact operation count independent of duration.
    await status();
    const httpDurations: number[] = [];
    const evidenceQueryDurations: number[] = [];
    const warmQueryCounts: number[] = [];
    for (let sample = 0; sample < 7; sample++) {
      const startIndex = queryTimings.length;
      const startTime = performance.now();
      const response = await status();
      httpDurations.push(performance.now() - startTime);
      assert.equal(response.body.state, "CONFIRMED_GRANTED");
      const readEvents = queryTimings.slice(startIndex);
      warmQueryCounts.push(readEvents.length);
      const joined = readEvents.filter(event => event.sql.includes("WhatsAppConsentEvidence"));
      assert.equal(joined.length, 1, "exactly one joined consent read per request");
      evidenceQueryDurations.push(joined[0]!.durationMs);
      assert.equal(readEvents.some(event => /\b(INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i.test(event.sql)),
        false, "status requests must remain read-only and transaction-free");
    }
    const afterEvidence = await database.whatsAppConsentEvidence.findMany({ where: { shopId: shop.id },
      orderBy: { eventId: "asc" } });
    const afterPhones = await database.customerPhone.findMany({ where: { customer: { shopId: shop.id } },
      orderBy: { id: "asc" } });
    assert.deepEqual(afterEvidence, beforeEvidence, "status may not modify grant evidence");
    assert.deepEqual(afterPhones, beforePhones, "status may not modify current checkbox consent");
    assert.equal(await database.checkoutRecovery.count({ where: { shopId: shop.id } }), beforeRecoveries,
      "status may not create recovery work");
    console.log(JSON.stringify({ scenario: "ARCH-046-API-006", measured: true,
      samples: httpDurations.length, firstReadSqlStatements: queries.length,
      warmReadSqlStatements: warmQueryCounts, joinedEvidenceQueriesPerRequest: 1,
      sqlEvidenceP50Ms: rounded(percentile(evidenceQueryDurations, 0.5)),
      sqlEvidenceP95Ms: rounded(percentile(evidenceQueryDurations, 0.95)),
      fullHttpP50Ms: rounded(percentile(httpDurations, 0.5)),
      fullHttpP95Ms: rounded(percentile(httpDurations, 0.95)),
      statusSideEffects: 0, explicitTransactions: 0 }));
    for (const attempt of [
      { ...probe, grantEventId: "fabricated" }, { ...probe, canonicalPhone: "447400123457" },
    ]) assert.equal((await status(attempt)).body.state, "UNVERIFIED");
    assert.equal((await status(probe, true)).body.state, "UNVERIFIED", "same phone, different merchant");
    const otherGrant = consentEvent({ eventId: `other-shop-${name.slice(0, 8)}`,
      canonicalPhone: phone, occurredAt: new Date(baseTime - 110_000).toISOString() });
    assert.equal((await request("/v1/woocommerce/whatsapp-consent", otherGrant, true)).body.status,
      "recorded", "other shop independently records a grant for the same canonical phone");
    const otherProbe: WooConsentStatusProbe = { ...probe, grantEventId: otherGrant.eventId };
    assert.equal((await status(otherProbe, true)).body.state, "CONFIRMED_GRANTED");
    assert.equal((await status(otherProbe)).body.state, "UNVERIFIED",
      "another shop's evidence never confers consent in the current shop");
    assert.equal((await status({ ...probe, customerId: "spoof" })).status, 400);
    assert.equal((await status({ ...probe, installationId: otherInstallation.id })).status, 400,
      "browser-supplied installation identity must be rejected");
    assert.equal((await status({ ...probe, shopId: other.id })).status, 400,
      "browser-supplied merchant identity must be rejected");
    assert.equal((await status({ ...probe, grantEventId: "" })).status, 400);
    // Authentication must reject a forged credential before any evidence query.
    const failedAuthSqlStart = sql.length;
    const forgedAuth = await fetch(`${origin}${WOO_CONSENT_STATUS_PATH}`, { method: "POST",
      headers: { "content-type": "application/json", "x-moda-installation-id": installation.id,
        authorization: `Bearer ${encodeSecret(Buffer.alloc(32, 0x55))}` }, body: JSON.stringify(probe) });
    assert.equal(forgedAuth.status, 401);
    assert.equal(sql.slice(failedAuthSqlStart).some(query => query.includes("WhatsAppConsentEvidence")), false);

    const otherCustomerGrant = consentEvent({ ...grant, eventId: `customer-b-${name.slice(0, 8)}`,
      canonicalPhone: "447400123458" });
    assert.equal((await request("/v1/woocommerce/whatsapp-consent", otherCustomerGrant)).body.status, "recorded");
    const otherCustomerEvidence = await database.whatsAppConsentEvidence.findUniqueOrThrow({
      where: { shopId_eventId: { shopId: shop.id, eventId: otherCustomerGrant.eventId } },
    });
    assert.notEqual(otherCustomerEvidence.customerId, evidence.customerId);
    assert.equal((await status({ ...probe, grantEventId: otherCustomerGrant.eventId })).body.state, "UNVERIFIED");
    await assert.rejects(database.whatsAppConsentEvidence.create({ data: {
      ...evidence, id: randomUUID(), eventId: `mismatch-${name}`, customerId: otherCustomerEvidence.customerId,
    } }), /Woo evidence must match exact current phone decision/);

    // Force a real SQL failure after installation authentication in this disposable database.
    await database.$executeRawUnsafe('ALTER TABLE "commerce"."WhatsAppConsentEvidence" RENAME TO "StatusFaultEvidence"');
    try {
      const failure = await status();
      assert.deepEqual([failure.status, failure.body, failure.cache],
        [503, { error: "consent_status_unavailable" }, "no-store"]);
    } finally {
      await database.$executeRawUnsafe('ALTER TABLE "commerce"."StatusFaultEvidence" RENAME TO "WhatsAppConsentEvidence"');
    }
    assert.equal((await status()).body.state, "CONFIRMED_GRANTED");

    // Real v2 write, not a fake mutation, must invalidate older evidence.
    const revoke = consentEvent({ eventId: `status-revoke-${name.slice(0, 8)}`,
      canonicalPhone: phone, decision: "REVOKE", disclosure: null,
      occurredAt: new Date(baseTime - 90_000).toISOString() });
    assert.equal((await request("/v1/woocommerce/whatsapp-consent", revoke)).body.decision, "REVOKE");
    assert.equal((await status()).body.state, "UNVERIFIED");
    const afterCommittedRevoke = await Promise.all(Array.from({ length: 4 }, () => status()));
    assert.equal(afterCommittedRevoke.every(result => result.body.state === "UNVERIFIED"), true,
      "parallel reads after committed REVOKE cannot confirm a stale grant");
    assert.equal((await status(otherProbe, true)).body.state, "CONFIRMED_GRANTED",
      "one merchant's withdrawal must not alter another merchant's checkbox decision");
    await database.customerPhone.update({ where: { id: evidence.customerPhoneId }, data: { endedAt: new Date() } });
    assert.equal((await status()).body.state, "UNVERIFIED", "ended recipient cannot restore an old grant");
    const newGrant = consentEvent({ eventId: `status-new-${name.slice(0, 8)}`,
      canonicalPhone: phone, occurredAt: new Date(baseTime - 60_000).toISOString() });
    assert.equal((await request("/v1/woocommerce/whatsapp-consent", newGrant)).body.status, "recorded");
    assert.equal((await status()).body.state, "UNVERIFIED", "old grant cannot resurrect consent");
    const latestProbe = { ...probe, grantEventId: newGrant.eventId };
    assert.equal((await status(latestProbe)).body.state, "CONFIRMED_GRANTED");
    const revisionGrant = consentEvent({ ...newGrant, eventId: `status-revision-${name.slice(0, 8)}`,
      occurredAt: new Date(baseTime - 50_000).toISOString() });
    assert.equal((await request("/v1/woocommerce/whatsapp-consent", revisionGrant)).body.status, "recorded");
    assert.equal((await status(latestProbe)).body.state, "UNVERIFIED", "newer grant invalidates the previous revision");
    latestProbe.grantEventId = revisionGrant.eventId;
    assert.equal((await status(latestProbe)).body.state, "CONFIRMED_GRANTED");
    const activePrincipal = { shopId: shop.id, installationId: installation.id,
      canonicalSiteUrl: shop.domain, credentialVersion: installation.credentialVersion };
    assert.equal((await new WooConsentStatusService(database).read(
      { ...activePrincipal, credentialVersion: activePrincipal.credentialVersion + 1 }, latestProbe)).state,
    "UNVERIFIED", "joined read rejects the wrong credential version even while consent is granted");
    assert.equal((await new WooConsentStatusService(database).read(
      { ...activePrincipal, canonicalSiteUrl: other.domain }, latestProbe)).state,
    "UNVERIFIED", "joined read rejects a mismatched installation site URL");

    // Changing the installation credential version invalidates a stale principal.
    await database.wooCommerceInstallation.update({ where: { id: installation.id }, data: {
      credentialVersion: { increment: 1 },
    } });
    assert.equal((await new WooConsentStatusService(database).read(
      activePrincipal, latestProbe)).state, "UNVERIFIED",
    "one joined read must reject a principal whose credential version is stale");

    await database.wooCommerceInstallation.update({ where: { id: installation.id }, data: {
      status: "REVOKED", revokedAt: new Date(),
    } });
    assert.equal((await status(latestProbe)).status, 401);
    assert.equal(await database.checkoutRecovery.count({ where: { shopId: shop.id } }), 0);
    assert.equal(queued, 0);
    assert.deepEqual(await effects(), effectsBefore, "consent probes must preserve send and billing state");
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await database.$disconnect();
  }
});
