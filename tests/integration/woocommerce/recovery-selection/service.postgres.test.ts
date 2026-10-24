import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { digestSecret, encodeSecret } from "../../../../src/auth/woo-installation/credential.js";
import { WooConsentService } from "../../../../src/woocommerce/consent/service.js";
import { createWooRecoverySelectionRoute } from "../../../../src/woocommerce/recovery-selection/routes.js";
import { WOO_RECOVERY_SELECTION_PATH, WOO_RECOVERY_SELECTION_VERSION,
  type WooRecoverySelectionChange } from "../../../../src/woocommerce/recovery-selection/contract.js";
import { WooRecoverySelectionService } from "../../../../src/woocommerce/recovery-selection/service.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";

const databaseUrl = process.env.WOO_CONSENT_TEST_DATABASE_URL;
const phone = "447400123477";

async function setup() {
  if (!databaseUrl) throw new Error("WOO_CONSENT_TEST_DATABASE_URL required");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const feature = await db.feature.findUniqueOrThrow({ where: { key: "checkout_recovery" } });
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `woo-opt-out-${randomUUID()}`, name: "Woo no-contact", kind: "FREE",
    } });
    await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id, enabled: true } });
    const install = async (index: number) => {
      const site = `https://woo-opt-out-${index}-${randomUUID()}.invalid`;
      const shop = await db.shop.create({ data: { domain: site, platform: "WOOCOMMERCE", onboardingCompleted: true } });
      await db.subscription.create({ data: { shopId: shop.id, planId: plan.id, status: "ACTIVE" } });
      const secret = Buffer.alloc(32, index + 30);
      const installation = await db.wooCommerceInstallation.create({ data: {
        shopId: shop.id, canonicalSiteUrl: site, credentialDigest: Uint8Array.from(digestSecret(secret)),
      } });
      return { shop, site, secret, installation, principal: {
        shopId: shop.id, canonicalSiteUrl: site, installationId: installation.id,
        credentialVersion: installation.credentialVersion,
      } };
    };
    return { db, one: await install(1), two: await install(2),
      service: new WooRecoverySelectionService(db) };
  } catch (error) { await db.$disconnect(); throw error; }
}

async function insertUnknown(db: PrismaClient, shopId: string, digits: string): Promise<string> {
  const customerId = randomUUID(), phoneId = randomUUID();
  await db.$executeRaw`INSERT INTO "commerce"."Customer" ("id", "shopId", "phone", "updatedAt")
    VALUES (${customerId}, ${shopId}, ${`+${digits}`}, CURRENT_TIMESTAMP)`;
  await db.$executeRaw`INSERT INTO "commerce"."CustomerPhone" ("id", "customerId", "phone", "whatsappCanonicalPhone", "updatedAt")
    VALUES (${phoneId}, ${customerId}, ${`+${digits}`}, ${digits}, CURRENT_TIMESTAMP)`;
  return phoneId;
}

async function grant(db: PrismaClient, input: Awaited<ReturnType<typeof setup>>["one"],
  digits: string, id: string, ageSeconds = 90): Promise<void> {
  await new WooConsentService(db).record(input.principal, consentEvent({
    eventId: id, canonicalPhone: digits,
    occurredAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
  }));
}

const command = (action: "SUPPRESS" | "REENABLE" | "RECORD_CUSTOMER_STOP", revision: string,
  canonicalPhone = phone): WooRecoverySelectionChange => ({ schemaVersion: WOO_RECOVERY_SELECTION_VERSION, canonicalPhone,
    action, expectedNoContactRevision: revision,
    evidenceReference: action === "RECORD_CUSTOMER_STOP" ? "ticket:offline-customer-request-1" : null });

async function serve(ctx: Awaited<ReturnType<typeof setup>>) {
  const route = createWooRecoverySelectionRoute({
    authenticator: new WooInstallationAuthenticator(ctx.db), service: ctx.service,
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  const server = createServer((req, res) => { void route.handle(req, res).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (installation: typeof ctx.one, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}${WOO_RECOVERY_SELECTION_PATH}`, { method: "POST",
      headers: { "content-type": "application/json", "x-moda-installation-id": installation.installation.id,
        authorization: `Bearer ${encodeSecret(installation.secret)}`,
        "x-moda-wp-admin-verified": "1", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
  const get = async (installation: typeof ctx.one, canonicalPhone: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}${WOO_RECOVERY_SELECTION_PATH}?canonicalPhone=${canonicalPhone}`, {
      headers: { "x-moda-installation-id": installation.installation.id,
        authorization: `Bearer ${encodeSecret(installation.secret)}`,
        "x-moda-wp-admin-verified": "1", ...headers },
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
  return { post, get, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("authenticated merchant suppression, idempotent replay, reenable, STOP precedence and no side effects", {
  skip: !databaseUrl,
}, async () => {
  const ctx = await setup(), http = await serve(ctx);
  try {
    await grant(ctx.db, ctx.one, phone, `grant-${randomUUID()}`);
    assert.deepEqual((await http.get(ctx.one, phone)).json, {
      schemaVersion: WOO_RECOVERY_SELECTION_VERSION, consentDecision: "GRANTED", suppressed: false,
      suppressionReason: null, noContactRevision: "0", phoneEligibleForRecovery: true, canReenable: false,
    });
    const disabled = await http.post(ctx.one, command("SUPPRESS", "0"));
    assert.deepEqual([disabled.status, disabled.json.outcome, disabled.json.noContactRevision], [200, "updated", "1"]);
    assert.equal((await http.post(ctx.one, command("SUPPRESS", "0"))).json.outcome, "duplicate");
    assert.deepEqual((await http.post(ctx.one, command("REENABLE", "0"))).json,
      { error: "stale_no_contact_revision" });
    const enabled = await http.post(ctx.one, command("REENABLE", "1"));
    assert.deepEqual([enabled.status, enabled.json.phoneEligibleForRecovery, enabled.json.noContactRevision],
      [200, true, "2"]);
    assert.equal((await http.post(ctx.one, command("REENABLE", "1"))).json.outcome, "duplicate");
    assert.equal((await http.post(ctx.one, command("SUPPRESS", "0"))).json.error,
      "stale_no_contact_revision");
    const stopped = await http.post(ctx.one, command("RECORD_CUSTOMER_STOP", "2"));
    assert.deepEqual([stopped.status, stopped.json.suppressionReason, stopped.json.noContactRevision],
      [200, "CUSTOMER_STOP", "3"]);
    assert.equal((await http.post(ctx.one, command("RECORD_CUSTOMER_STOP", "2"))).json.outcome, "duplicate");
    assert.deepEqual((await http.post(ctx.one, command("REENABLE", "3"))).json,
      { error: "customer_stop_authoritative" });
    assert.deepEqual((await http.post(ctx.one, command("SUPPRESS", "3"))).json,
      { error: "customer_stop_authoritative" });
    await grant(ctx.db, ctx.one, phone, `new-grant-${randomUUID()}`, 40);
    assert.equal((await http.get(ctx.one, phone)).json.suppressionReason, "CUSTOMER_STOP");
    assert.equal((await http.get(ctx.one, phone)).json.phoneEligibleForRecovery, false);
    assert.equal(await ctx.db.checkoutRecovery.count({ where: { shopId: ctx.one.shop.id } }), 0);
    assert.equal(await ctx.db.billingOperation.count({ where: { shopId: ctx.one.shop.id } }), 0);
    assert.equal(await ctx.db.whatsAppConsentEvidence.count({ where: { shopId: ctx.one.shop.id } }), 2);
  } finally { await http.close(); await ctx.db.$disconnect(); }
});

test("cross-tenant, unknown/non-consented, ambiguous, changed-number and active-installation security", {
  skip: !databaseUrl,
}, async () => {
  const ctx = await setup(), http = await serve(ctx);
  try {
    const firstPhone = await insertUnknown(ctx.db, ctx.one.shop.id, phone);
    const secondPhone = await insertUnknown(ctx.db, ctx.two.shop.id, phone);
    assert.equal((await http.post(ctx.one, command("REENABLE", "0"))).json.error, "customer_consent_required");
    assert.equal((await http.post(ctx.one, command("SUPPRESS", "0"))).status, 200);
    assert.equal((await http.get(ctx.two, phone)).json.suppressed, false);
    assert.equal((await http.post(ctx.two, command("REENABLE", "0"))).json.error, "customer_consent_required");
    assert.equal((await http.post(ctx.two, command("RECORD_CUSTOMER_STOP", "0"))).status, 200);
    assert.equal((await http.get(ctx.one, phone)).json.suppressionReason, "MERCHANT_OPT_OUT");
    assert.equal((await http.get(ctx.two, phone)).json.suppressionReason, "CUSTOMER_STOP");
    assert.equal((await http.post(ctx.one, { ...command("SUPPRESS", "1"), shopId: ctx.two.shop.id })).status, 400);
    assert.equal((await http.post(ctx.one, command("SUPPRESS", "1"), { "x-moda-wp-admin-verified": "0" })).status, 403);
    assert.equal((await http.get(ctx.one, phone, { authorization: "Bearer invalid" })).status, 401);
    assert.equal((await http.get(ctx.one, "447400123499")).status, 404);
    // Two active customers with the same canonical recipient must not be merged
    // or selected by an arbitrary query ordering.
    await insertUnknown(ctx.db, ctx.one.shop.id, phone);
    assert.deepEqual((await http.get(ctx.one, phone)).json, { error: "ambiguous_customer_phone" });
    assert.equal((await http.post(ctx.one, command("SUPPRESS", "1"))).status, 409);
    // Same row, different canonical phone: old merchant selection is invalid.
    const changed = "447400123478";
    await ctx.db.$executeRaw`UPDATE "commerce"."CustomerPhone" SET
      "whatsappCanonicalPhone"=${changed}, "phone"=${`+${changed}`},
      "whatsappConsentRevision"="whatsappConsentRevision"+1, "updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=${secondPhone}`;
    assert.equal((await http.get(ctx.two, phone)).status, 404);
    assert.equal((await http.get(ctx.two, changed)).status, 200);
    await ctx.db.wooCommerceInstallation.update({ where: { id: ctx.two.installation.id },
      data: { credentialVersion: { increment: 1 } } });
    await assert.rejects(() => ctx.service.read(ctx.two.principal, changed), WooUnauthenticatedError);
    await ctx.db.wooCommerceInstallation.update({ where: { id: ctx.two.installation.id },
      data: { status: "REVOKED", revokedAt: new Date() } });
    assert.equal((await http.get(ctx.two, changed)).status, 401);
    // The recorded merchant override for the original recipient survives an
    // unrelated installation's rotation and customer number change.
    assert.equal((await ctx.db.customerPhone.findUniqueOrThrow({ where: { id: firstPhone } })).whatsappNoContact, true);
    assert.equal(await ctx.db.checkoutRecovery.count({ where: { shopId: ctx.two.shop.id } }), 0);
  } finally { await http.close(); await ctx.db.$disconnect(); }
});

test("simultaneous merchant operations serialize per recipient and prevent stale reenable", {
  skip: !databaseUrl,
}, async () => {
  const ctx = await setup();
  try {
    await insertUnknown(ctx.db, ctx.one.shop.id, phone);
    const [a, b] = await Promise.allSettled([
      ctx.service.change(ctx.one.principal, command("SUPPRESS", "0")),
      ctx.service.change(ctx.one.principal, command("RECORD_CUSTOMER_STOP", "0")),
    ]);
    assert.equal([a.status, b.status].filter(s => s === "fulfilled").length, 1);
    const latest = await ctx.service.read(ctx.one.principal, phone);
    assert.equal(latest.noContactRevision, "1");
    assert.equal(latest.suppressed, true);
    assert.deepEqual(["MERCHANT_OPT_OUT", "CUSTOMER_STOP"].includes(latest.suppressionReason ?? ""), true);
    if (latest.suppressionReason === "MERCHANT_OPT_OUT") {
      const upgraded = await ctx.service.change(ctx.one.principal, command("RECORD_CUSTOMER_STOP", "1"));
      assert.equal(upgraded.suppressionReason, "CUSTOMER_STOP");
    }
    assert.equal((await ctx.service.read(ctx.one.principal, phone)).suppressionReason, "CUSTOMER_STOP");
    assert.equal(await ctx.db.checkoutRecovery.count({ where: { shopId: ctx.one.shop.id } }), 0);
  } finally { await ctx.db.$disconnect(); }
});
