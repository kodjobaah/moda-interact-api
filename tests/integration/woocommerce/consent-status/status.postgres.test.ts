import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

test("real HTTP route: one joined status read checks GRANT, REVOKE and installation identity", {
  skip: !url,
}, async () => {
  if (!url) return;
  const database = new PrismaClient({ datasources: { db: { url } },
    log: [{ level: "query", emit: "event" }],
  });
  const sql: string[] = [];
  database.$on("query", event => sql.push(event.query));
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
    const woo = createWooRoutes({ prisma: database, authenticator,
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
    const request = async (path: string, payload: unknown, useOther = false) => {
      const response = await fetch(`${origin}${path}`, { method: "POST",
        headers: { "content-type": "application/json",
          "x-moda-installation-id": useOther ? otherInstallation.id : installation.id,
          authorization: `Bearer ${encodeSecret(useOther ? otherSecret : secret)}` },
        body: JSON.stringify(payload),
      });
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
    const before = sql.length;
    const confirmed = await status();
    const queries = sql.slice(before);
    assert.deepEqual([confirmed.status, confirmed.body, confirmed.cache],
      [200, { schemaVersion: WOO_CONSENT_STATUS_VERSION, state: "CONFIRMED_GRANTED" }, "no-store"]);
    assert.equal(queries.filter(query => query.includes("WhatsAppConsentEvidence")).length, 1,
      "exactly one indexed evidence/current-state SELECT");
    assert.equal(queries.some(query => /BEGIN|COMMIT|ROLLBACK|Subscription|FeaturePreference/i.test(query)), false,
      "no transaction, subscription or feature queries on a status read");
    console.log(`ARCH-046-API-006 actual_status_read_sql_statements=${queries.length}; joined_evidence_queries=1`);
    for (const attempt of [
      { ...probe, grantEventId: "fabricated" }, { ...probe, canonicalPhone: "447400123457" },
    ]) assert.equal((await status(attempt)).body.state, "UNVERIFIED");
    assert.equal((await status(probe, true)).body.state, "UNVERIFIED", "same phone, different merchant");
    assert.equal((await status({ ...probe, customerId: "spoof" })).status, 400);

    // Real v2 write, not a fake mutation, must invalidate older evidence.
    const revoke = consentEvent({ eventId: `status-revoke-${name.slice(0, 8)}`,
      canonicalPhone: phone, decision: "REVOKE", disclosure: null,
      occurredAt: new Date(baseTime - 90_000).toISOString() });
    assert.equal((await request("/v1/woocommerce/whatsapp-consent", revoke)).body.decision, "REVOKE");
    assert.equal((await status()).body.state, "UNVERIFIED");
    const newGrant = consentEvent({ eventId: `status-new-${name.slice(0, 8)}`,
      canonicalPhone: phone, occurredAt: new Date(baseTime - 60_000).toISOString() });
    assert.equal((await request("/v1/woocommerce/whatsapp-consent", newGrant)).body.status, "recorded");
    assert.equal((await status()).body.state, "UNVERIFIED", "old grant cannot resurrect consent");
    const latestProbe = { ...probe, grantEventId: newGrant.eventId };
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
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await database.$disconnect();
  }
});
