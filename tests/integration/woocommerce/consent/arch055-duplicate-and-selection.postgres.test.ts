import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { digestSecret } from "../../../../src/auth/woo-installation/credential.js";
import type { WooConsentEvent } from "../../../../src/woocommerce/consent/contract.js";
import { WooConsentService } from "../../../../src/woocommerce/consent/service.js";
import { WooRecoverySelectionService } from "../../../../src/woocommerce/recovery-selection/service.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";

const databaseUrl = process.env.WOO_CONSENT_TEST_DATABASE_URL;
const measurementVersion = process.env.ARCH055_M03_VERSION;
const now = new Date("2026-10-22T16:00:00.000Z");
const m03Now = new Date("2026-11-02T12:00:00.000Z");
const phone = "447400123463";
const observedAt = (secondsBeforeNow: number, clock = now) =>
  new Date(clock.getTime() - secondsBeforeNow * 1000).toISOString();

function event(id: string, decision: "GRANT" | "REVOKE", secondsBeforeNow: number, clock = now): WooConsentEvent {
  const example = consentEvent();
  return consentEvent({ eventId: id, decision, canonicalPhone: phone,
    occurredAt: observedAt(secondsBeforeNow, clock), disclosure: decision === "GRANT" ? example.disclosure : null });
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

type M03Transaction = { durationMs: number; outcome: "commit" | "rollback" };
type M03Stats = {
  transactions: M03Transaction[];
  returnedRows: number[];
  affectedRows: number[];
};

function observeTransaction(tx: Prisma.TransactionClient, stats: M03Stats): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === "$queryRaw" || property === "$executeRaw") {
        const method = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => Promise.resolve(Reflect.apply(method, target, args)).then(result => {
          if (property === "$queryRaw" && Array.isArray(result)) stats.returnedRows.push(result.length);
          if (property === "$executeRaw" && typeof result === "number") stats.affectedRows.push(result);
          return result;
        });
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function observedDatabase(db: PrismaClient, stats: M03Stats): Pick<PrismaClient, "$transaction"> {
  return { $transaction: (async <T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number },
  ): Promise<T> => {
    const started = performance.now();
    try {
      const result = await db.$transaction(tx => callback(observeTransaction(tx, stats)), options);
      stats.transactions.push({ durationMs: performance.now() - started, outcome: "commit" });
      return result;
    } catch (error) {
      stats.transactions.push({ durationMs: performance.now() - started, outcome: "rollback" });
      throw error;
    }
  }) as PrismaClient["$transaction"] };
}

type M03Profile = "duplicate-replay" | "new-event-same-recipient" | "selection-get";

async function seedM03Trial(db: PrismaClient, profile: M03Profile, trial: string) {
  const suffix = `${measurementVersion}_${profile}_${trial}`.replaceAll("-", "_");
  const shopId = `arch055_m03_${suffix}_shop`;
  const installationId = `arch055_m03_${suffix}_installation`;
  const customerId = `arch055_m03_${suffix}_customer`;
  const phoneId = `arch055_m03_${suffix}_phone`;
  const site = `https://${suffix}.arch055.invalid`;
  const shop = await db.shop.create({ data: {
    id: shopId, domain: site, platform: "WOOCOMMERCE", onboardingCompleted: true,
  } });
  const installation = await db.wooCommerceInstallation.create({ data: {
    id: installationId, shopId, canonicalSiteUrl: site,
    credentialDigest: Uint8Array.from(digestSecret(Buffer.alloc(32, 0x55))),
  } });
  await db.customer.create({ data: { id: customerId, shopId, phone: `+${phone}` } });
  await db.customerPhone.create({ data: {
    id: phoneId, customerId, phone: `+${phone}`, whatsappCanonicalPhone: phone,
  } });
  const principal = { shopId, installationId, canonicalSiteUrl: site,
    credentialVersion: installation.credentialVersion };
  const service = new WooConsentService(db, () => m03Now);
  const grant = event(`m03-${suffix}-grant`, "GRANT", 120, m03Now);
  const grantResult = await service.record(principal, grant);
  assert.equal(grantResult.status, "recorded");

  if (profile === "duplicate-replay") {
    assert.equal((await service.record(principal, event(`m03-${suffix}-revoke`, "REVOKE", 60, m03Now))).status, "recorded");
    await db.$executeRaw`
      UPDATE "commerce"."CustomerPhone" SET "whatsappNoContact" = TRUE,
        "whatsappNoContactReason" = 'CUSTOMER_STOP', "whatsappNoContactAt" = ${m03Now},
        "whatsappNoContactRevision" = "whatsappNoContactRevision" + 1
      WHERE "id" = ${phoneId}
    `;
  }

  return { principal, shopId, phoneId, grant, grantResult };
}

async function m03PhoneState(db: PrismaClient, phoneId: string) {
  return db.customerPhone.findUniqueOrThrow({ where: { id: phoneId }, select: {
    whatsappConsentDecision: true, whatsappConsentSource: true,
    whatsappConsentProviderObservedAt: true, whatsappConsentRevision: true,
    whatsappConsentDecisionSequence: true, whatsappNoContact: true,
    whatsappNoContactReason: true, whatsappNoContactRevision: true,
    updatedAt: true,
  } });
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function durationSummary(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minMs: Number(sorted[0]!.toFixed(2)),
    medianMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(2)),
    maxMs: Number(sorted.at(-1)!.toFixed(2)),
  };
}

test("ARCH-055 M03 paired SQL and affected-row profiles", {
  skip: !databaseUrl || !["baseline", "candidate"].includes(measurementVersion ?? ""),
}, async () => {
  if (!databaseUrl || !measurementVersion) return;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } },
    log: [{ level: "query", emit: "event" }],
  });
  const queryEvents: Array<{ query: string; duration: number }> = [];
  let captureQueries = false;
  db.$on("query", query => {
    if (captureQueries) queryEvents.push({ query: query.query, duration: query.duration });
  });
  const profiles: M03Profile[] = ["duplicate-replay", "new-event-same-recipient", "selection-get"];

  try {
    for (const profile of profiles) {
      const recordedWallTimes: number[] = [];
      const recordedTransactionTimes: number[] = [];
      for (let index = 0; index < 7; index++) {
        const warmup = index < 2;
        const trial = `${warmup ? "warmup" : "sample"}_${warmup ? index : index - 2}`;
        const fixture = await seedM03Trial(db, profile, trial);
        const beforePhone = await m03PhoneState(db, fixture.phoneId);
        const beforeEvidence = await db.whatsAppConsentEvidence.count({ where: { shopId: fixture.shopId } });
        const stats: M03Stats = { transactions: [], returnedRows: [], affectedRows: [] };
        queryEvents.length = 0;
        const started = performance.now();
        let result: unknown;
        captureQueries = true;

        if (profile === "duplicate-replay") {
          result = await new WooConsentService(observedDatabase(db, stats), () => m03Now)
            .record(fixture.principal, fixture.grant);
          assert.deepEqual(result, { ...fixture.grantResult, status: "duplicate" });
        } else if (profile === "new-event-same-recipient") {
          result = await new WooConsentService(observedDatabase(db, stats), () => m03Now)
            .record(fixture.principal, event(`m03-${profile}-${trial}`, "REVOKE", 60, m03Now));
          assert.equal((result as { status: string }).status, "recorded");
        } else {
          result = await new WooRecoverySelectionService(observedDatabase(db, stats), () => m03Now)
            .read(fixture.principal, phone);
          assert.equal((result as { phoneEligibleForRecovery: boolean }).phoneEligibleForRecovery, true);
        }

        const wallMs = performance.now() - started;
        captureQueries = false;
        const statements = [...queryEvents];
        const afterPhone = await m03PhoneState(db, fixture.phoneId);
        const afterEvidence = await db.whatsAppConsentEvidence.count({ where: { shopId: fixture.shopId } });
        const phoneRowsChanged = Number(JSON.stringify(beforePhone, (_, value) =>
          typeof value === "bigint" ? value.toString() : value) !== JSON.stringify(afterPhone, (_, value) =>
          typeof value === "bigint" ? value.toString() : value));
        const evidenceRowsChanged = afterEvidence - beforeEvidence;
        const affectedTargetRows = phoneRowsChanged + evidenceRowsChanged;
        const normalized = statements.map(item => normalizeSql(item.query));
        const advisoryLocks = normalized.filter(query => /pg_advisory_xact_lock/i.test(query)).length;
        const forUpdate = normalized.filter(query => /\bFOR UPDATE\b/i.test(query)).length;

        assert.equal(stats.transactions.length, 1, `${profile} should use one transaction`);
        assert.equal(stats.transactions[0]?.outcome, "commit");
        assert.equal(affectedTargetRows, profile === "new-event-same-recipient" ? 2 : 0);
        if (profile === "duplicate-replay") {
          assert.equal((result as { status: string }).status, "duplicate");
          assert.equal(beforePhone.whatsappConsentDecision, "REVOKED");
          assert.equal(beforePhone.whatsappNoContactReason, "CUSTOMER_STOP");
          assert.equal(advisoryLocks, measurementVersion === "baseline" ? 2 : 1);
        } else if (profile === "new-event-same-recipient") {
          assert.equal(advisoryLocks, 2);
        } else {
          assert.equal(advisoryLocks, measurementVersion === "baseline" ? 1 : 0);
          assert.equal(forUpdate, 0);
        }

        const controlStatements = normalized.reduce((counts, query) => {
          if (/^BEGIN\b/i.test(query)) counts.begin++;
          if (/^COMMIT\b/i.test(query)) counts.commit++;
          if (/^ROLLBACK\b/i.test(query)) counts.rollback++;
          if (/\b(?:SET TRANSACTION|ISOLATION LEVEL)\b/i.test(query)) counts.isolation++;
          return counts;
        }, { begin: 0, commit: 0, rollback: 0, isolation: 0 });
        const grouped = new Map<string, number>();
        for (const query of normalized) grouped.set(query, (grouped.get(query) ?? 0) + 1);
        const sample = {
          version: measurementVersion, profile, sample: warmup ? `warmup-${index}` : `recorded-${index - 2}`,
          logicalClientCalls: 1, sqlStatementCount: normalized.length,
          sqlShapes: [...grouped].map(([sql, count]) => ({ count, sql })),
          rawQueryReturnedRows: stats.returnedRows, rawExecuteAffectedRows: stats.affectedRows,
          affectedTargetRows, advisoryLockStatements: advisoryLocks, forUpdateStatements: forUpdate,
          transactionCount: stats.transactions.length, transactionOutcome: stats.transactions[0]?.outcome,
          transactionMs: Number(stats.transactions[0]!.durationMs.toFixed(2)),
          operationMs: Number(wallMs.toFixed(2)), transactionControlSqlEvents: controlStatements,
          statementDurationMs: Number(statements.reduce((sum, item) => sum + item.duration, 0).toFixed(2)),
          retries: 0, externalPortInvocations: 0, wireBytes: "not measured",
        };
        console.log(`ARCH055_M03_SAMPLE ${JSON.stringify(sample)}`);
        if (!warmup) {
          recordedWallTimes.push(wallMs);
          recordedTransactionTimes.push(stats.transactions[0]!.durationMs);
        }
      }
      console.log(`ARCH055_M03_SUMMARY ${JSON.stringify({ version: measurementVersion, profile,
        recordedSamples: 5, operationMs: durationSummary(recordedWallTimes),
        transactionMs: durationSummary(recordedTransactionTimes) })}`);
    }
  } finally {
    await db.$disconnect();
  }
});
