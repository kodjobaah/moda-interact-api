import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { Prisma, PrismaClient, type BillingOperation, type MerchantPricingPlan } from "@prisma/client";
import { WooInstallationAuthenticator } from "../../../../src/auth/woo-installation/authenticator.js";
import { digestSecret, encodeSecret } from "../../../../src/auth/woo-installation/credential.js";
import { RecurringSubscriptionCommandService } from "../../../../src/billing/commands/recurring-subscription-command.service.js";
import { RecoveryCreditPurchaseCommandService } from "../../../../src/billing/commands/recovery-credit-purchase-command.service.js";
import { RecurringOutcomePersistence } from "../../../../src/billing/commands/recurring-outcome.js";
import { RecoveryCreditOutcomePersistence } from "../../../../src/billing/commands/recovery-credit-outcome.js";
import { createBillingCommandRoutes } from "../../../../src/billing/commands/routes.js";
import { publishedPricingTranslations } from "../../../helpers/merchant-pricing-test-fixtures.js";

const url = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const measuring = process.env.ARCH055_BILLING_MEASURE;
const db = new PrismaClient({ transactionOptions: { timeout: 30_000, maxWait: 30_000 }, datasources: { db: { url: url ?? "postgresql://unused:unused@localhost/unused" } }, log: [{ emit: "event", level: "query" }] });
const competitor = new PrismaClient({ transactionOptions: { timeout: 30_000, maxWait: 30_000 }, datasources: { db: { url: url ?? "postgresql://unused:unused@localhost/unused" } } });
after(async () => {
  try {
    if (url) {
      await db.shop.deleteMany({ where: { id: { startsWith: "arch055-billing-" } } });
      await db.billingPlan.deleteMany({ where: { shopifyPlanHandle: { startsWith: "arch055-billing-plan-" } } });
      await db.merchantPricingPlan.deleteMany({ where: { id: { startsWith: "arch055-billing-plan-" } } });
    }
  } finally { await Promise.all([db.$disconnect(), competitor.$disconnect()]); }
});
const clock = new Date("2026-11-02T12:00:00.000Z");
const secret = Buffer.alloc(32, 17);
type Kind = "create" | "cancel" | "switch" | "purchase";
type Catalogue = MerchantPricingPlan;
type Configuration = { free: Catalogue; paid: Catalogue; target: Catalogue; freePlan: string; paidPlan: string; bundle: string };
let configuration: Configuration | undefined;

async function config(): Promise<Configuration> {
  if (configuration) return configuration;
  const feature = await db.feature.findUniqueOrThrow({ where: { key: "checkout_recovery" } });
  const catalogues: Catalogue[] = [];
  for (const [index, kind] of (["FREE", "PAID_METERED", "PAID_METERED"] as const).entries()) {
    const id = "arch055-billing-plan-" + index;
    catalogues.push(await db.merchantPricingPlan.create({ data: {
      id, shopifyPlanHandle: id, displayName: "Billing " + index, planKind: kind, isActive: true,
      cataloguePosition: await db.merchantPricingPlan.count(),
      allowancePeriod: kind === "FREE" ? "LIFETIME" : "EVERY_30_DAYS", billingPeriod: "EVERY_30_DAYS",
      recurringAmountMinor: kind === "FREE" ? 0 : 4900, includedRecoveryCredits: 10, currency: "USD",
      materializedAt: clock, translations: { create: publishedPricingTranslations("Billing " + index) },
      features: { create: { featureId: feature.id, configuration: {} } },
    } }));
    await db.billingPlan.create({ data: { id: id + "-operational", shopifyPlanHandle: id, name: id, kind, active: true, features: { create: { featureId: feature.id, enabled: true, configuration: {} } } } });
  }
  const bundle = await db.merchantPricingUsageEvent.create({ data: {
    id: "arch055-billing-bundle", merchantPricingPlanId: catalogues[0]!.id, eventHandle: "arch055-credit-bundle",
    adminLabel: "Credits", position: 0, pricingMode: "FIXED", fixedUnitAmountMinor: 1200, currency: "USD", creditsGrantedPerUnit: 10,
  } });
  configuration = { free: catalogues[0]!, paid: catalogues[1]!, target: catalogues[2]!,
    freePlan: catalogues[0]!.id + "-operational", paidPlan: catalogues[1]!.id + "-operational", bundle: bundle.id };
  return configuration;
}

async function fixture(label: string, kind: Kind) {
  const c = await config();
  const id = "arch055-billing-" + label;
  const domain = "https://" + id + ".invalid";
  await db.shop.create({ data: { id, domain, platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true } });
  const installation = await db.wooCommerceInstallation.create({ data: {
    id: id + "-installation", shopId: id, canonicalSiteUrl: domain, credentialDigest: Uint8Array.from(digestSecret(secret)), credentialVersion: 1,
  } });
  const paid = kind === "cancel" || kind === "switch";
  const subscription = await db.subscription.create({ data: {
    id: id + "-subscription", shopId: id, planId: paid ? c.paidPlan : c.freePlan, status: "ACTIVE",
    providerSubscriptionId: paid ? id + "-contract" : null,
  } });
  const principal = await new WooInstallationAuthenticator(db).authenticate({
    rawHeaders: ["x-moda-installation-id", installation.id, "authorization", "Bearer " + encodeSecret(secret)],
  } as IncomingMessage);
  return { id, installation, principal, subscription, c, kind };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function barrier() {
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, pause: async () => { entered(); await released; } };
}

function services(database: Pick<PrismaClient, "$transaction">, f: Fixture, beforeProvider = async () => {}) {
  let invocations = 0;
  const provider = {
    createSubscription: async () => { invocations++; await beforeProvider(); return { id: f.id + "-provider", confirmation_url: "https://woocommerce.com/checkout/fixed" }; },
    cancelSubscription: async () => { invocations++; await beforeProvider(); },
    switchSubscription: async (id: string) => { invocations++; await beforeProvider(); return { id, confirmation_url: "https://woocommerce.com/checkout/fixed" }; },
    createCharge: async () => { invocations++; await beforeProvider(); const h = createHash("md5").update(f.id).digest("hex"); return { id: h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20), confirmation_url: "https://woocommerce.com/checkout/fixed" }; },
  };
  return { recurring: new RecurringSubscriptionCommandService(database, provider, "production"),
    credit: new RecoveryCreditPurchaseCommandService(database, provider, "production"), count: () => invocations };
}

async function invoke(f: Fixture, s: ReturnType<typeof services>, key = "fresh") {
  if (f.kind === "create") return s.recurring.create(f.principal, key, f.c.target.id);
  if (f.kind === "switch") return s.recurring.switchPlan(f.principal, key, f.c.target.id);
  if (f.kind === "cancel") return s.recurring.cancel(f.principal, key);
  return s.credit.initiate(f.principal, key, f.c.bundle);
}

function request(f: Fixture, key: string, authorized = true): IncomingMessage {
  const path = f.kind === "purchase" ? "/v1/billing/recovery-credit-purchases" :
    f.kind === "switch" ? "/v1/billing/subscription/switch" : "/v1/billing/subscription";
  const body = f.kind === "cancel" ? undefined : f.kind === "purchase"
    ? { merchantPricingUsageEventId: f.c.bundle } : { merchantPricingPlanId: f.c.target.id };
  return Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method: f.kind === "cancel" ? "DELETE" : "POST", url: path,
    rawHeaders: ["x-moda-installation-id", f.installation.id, "authorization", "Bearer " + encodeSecret(authorized ? secret : Buffer.alloc(32, 2)),
      "idempotency-key", key, ...(body ? ["content-type", "application/json"] : [])],
  }) as IncomingMessage;
}
function response() {
  let status = 0; let body = "";
  return { value: () => ({ status, body: JSON.parse(body) as unknown }),
    output: { destroyed: false, headersSent: false, writeHead(s: number) { status = s; }, end(s: string) { body = s; } } as unknown as ServerResponse };
}
const logger = { info() {}, warn() {}, error() {} } as never;

async function snapshot(f: Fixture) {
  return {
    subscription: await db.subscription.findUnique({ where: { shopId: f.id } }),
    operations: await db.billingOperation.findMany({ where: { shopId: f.id }, orderBy: { id: "asc" } }),
    purchases: await db.recoveryCreditPurchase.findMany({ where: { shopId: f.id }, orderBy: { id: "asc" } }),
    counters: await db.shopEntitlementCounter.findMany({ where: { shopId: f.id } }),
    catalogue: await db.merchantPricingPlan.findUnique({ where: { id: f.c.target.id } }),
  };
}

test("ARCH-055 G01 real authentication before rotation/revocation/suspension rejects all routes and existing keys", { skip: !url || !!measuring }, async () => {
  for (const kind of ["create", "cancel", "switch", "purchase"] as const) for (const mutation of ["rotate", "revoke", "suspend", "replay"] as const) {
    const f = await fixture(kind + "-" + mutation, kind);
    const s = services(db, f);
    const key = "gate-key";
    if (mutation === "replay") await invoke(f, s, key);
    const before = await snapshot(f);
    const callsBefore = s.count();
    const gate = barrier();
    const authenticator = new WooInstallationAuthenticator(db);
    const route = createBillingCommandRoutes({
      authenticator: { authenticate: async (req: IncomingMessage) => {
        const principal = await authenticator.authenticate(req);
        await gate.pause();
        return principal;
      } } as never, recurringSubscriptionCommandService: s.recurring, recoveryCreditPurchaseCommandService: s.credit, logger,
    });
    const reply = response();
    const pending = route.handle(request(f, key), reply.output);
    try {
      await gate.reached;
      if (mutation === "suspend") await competitor.shop.update({ where: { id: f.id }, data: { status: "SUSPENDED" } });
      else await competitor.wooCommerceInstallation.update({ where: { id: f.installation.id }, data: mutation === "revoke"
        ? { status: "REVOKED", revokedAt: new Date() } : { credentialVersion: { increment: 1 }, credentialDigest: Uint8Array.from(digestSecret(Buffer.alloc(32, 9))) } });
    } finally { gate.release(); }
    await pending;
    assert.deepEqual(reply.value(), { status: 409, body: { error: "billing_shop_invalid" } });
    assert.equal(s.count(), callsBefore);
    assert.deepEqual(await snapshot(f), before);
  }
});

test("ARCH-055 G01 invalid credential and unexpected helper database failure retain 401/500", { skip: !url || !!measuring }, async () => {
  const f = await fixture("helper-failure", "create");
  const failure = new Error("distinct-helper-database-failure");
  const failingDb = { $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
    db.$transaction(tx => callback(new Proxy(tx, { get(target, key, receiver) {
      if (key === "wooCommerceInstallation") return { findUnique: async () => { throw failure; } };
      return Reflect.get(target, key, receiver);
    } })), options) };
  const s = services(failingDb as never, f);
  const errors: unknown[] = [];
  const route = createBillingCommandRoutes({ authenticator: new WooInstallationAuthenticator(db),
    recurringSubscriptionCommandService: s.recurring, logger: { info() {}, warn() {}, error(_name: string, fields: unknown) { errors.push(fields); } } as never });
  for (const [authorized, status, code] of [[false, 401, "unauthorized"], [true, 500, "internal_error"]] as const) {
    const reply = response(); await route.handle(request(f, "failure", authorized), reply.output);
    assert.deepEqual(reply.value(), { status, body: { error: code } });
  }
  assert.equal(s.count(), 0); assert.equal(await db.billingOperation.count({ where: { shopId: f.id } }), 0);
  assert.equal((errors[0] as { errorMessage: string }).errorMessage, failure.message);
});

test("ARCH-055 G02 post-admission rotation preserves all four provider outcomes without activating credits or plans", { skip: !url || !!measuring }, async () => {
  for (const kind of ["create", "cancel", "switch", "purchase"] as const) {
    const f = await fixture("outcome-" + kind, kind);
    const gate = barrier();
    const s = services(db, f, gate.pause);
    const pending = invoke(f, s);
    try {
      await gate.reached;
      assert.equal((await db.billingOperation.findFirstOrThrow({ where: { shopId: f.id } })).state, "INITIATING");
      for (const purchase of await db.recoveryCreditPurchase.findMany({ where: { shopId: f.id } })) assert.equal(purchase.currentAmount, 0);
      await competitor.wooCommerceInstallation.update({ where: { id: f.installation.id }, data: { credentialVersion: { increment: 1 } } });
    } finally { gate.release(); }
    const result = await pending;
    assert.equal(result.state, kind === "cancel" ? "CONFIRMED" : "AWAITING_CONFIRMATION");
    assert.equal(s.count(), 1);
    assert.deepEqual(await db.subscription.findUnique({ where: { shopId: f.id } }), f.subscription);
    for (const purchase of await db.recoveryCreditPurchase.findMany({ where: { shopId: f.id } })) {
      assert.equal(purchase.status, "REQUESTED"); assert.equal(purchase.currentAmount, 0);
    }
  }
});

test("ARCH-055 G04 real newer outcome wins guarded returning updates", { skip: !url || !!measuring }, async () => {
  for (const kind of ["create", "purchase"] as const) {
    const f = await fixture("loser-" + kind, kind);
    const gate = barrier(); const s = services(db, f, gate.pause);
    const pending = invoke(f, s);
    try {
      await gate.reached;
      const operation = await db.billingOperation.findFirstOrThrow({ where: { shopId: f.id } });
      await competitor.billingOperation.update({ where: { id: operation.id }, data: {
        state: "CONFIRMED", providerReference: kind === "create" ? f.id + "-winner" : randomUUID(),
        confirmationUrl: "https://woocommerce.com/checkout/winner",
      } });
    } finally { gate.release(); }
    const result = await pending;
    assert.equal(result.state, "CONFIRMED"); assert.equal(result.confirmationUrl, "https://woocommerce.com/checkout/winner");
  }
});

test("ARCH-055 M15 paired billing evidence", { skip: !url || !measuring }, async () => {
  const root = process.env.ARCH055_BILLING_SOURCE_ROOT ?? process.cwd();
  const load = (file: string) => import(pathToFileURL(resolve(root, "src", file)).href);
  const [recurringModule, creditModule, recurringIntentModule, creditIntentModule, freeModule, recurringOutcomeModule, creditOutcomeModule] = await Promise.all([
    load("billing/commands/recurring-subscription-command.service.ts"),
    load("billing/commands/recovery-credit-purchase-command.service.ts"),
    load("billing/commands/recurring-intent.ts"), load("billing/commands/recovery-credit-intent.ts"),
    load("woocommerce/billing/initial-free-activation.service.ts"),
    load("billing/commands/recurring-outcome.ts"), load("billing/commands/recovery-credit-outcome.ts"),
  ]);
  const Recurring = recurringModule.RecurringSubscriptionCommandService as typeof RecurringSubscriptionCommandService;
  const Credit = creditModule.RecoveryCreditPurchaseCommandService as typeof RecoveryCreditPurchaseCommandService;
  const { RecurringIntentPersistence } = recurringIntentModule as typeof import("../../../../src/billing/commands/recurring-intent.js");
  const { RecoveryCreditIntentPersistence } = creditIntentModule as typeof import("../../../../src/billing/commands/recovery-credit-intent.js");
  const { InitialWooFreeActivationService } = freeModule as typeof import("../../../../src/woocommerce/billing/initial-free-activation.service.js");
  const Outcome = recurringOutcomeModule.RecurringOutcomePersistence as typeof RecurringOutcomePersistence;
  const CreditOutcome = creditOutcomeModule.RecoveryCreditOutcomePersistence as typeof RecoveryCreditOutcomePersistence;
  type Call = { method: string; returned: number | null; affected: number; select: unknown };
  let calls: Call[] | undefined; let sql: string[] | undefined; let txMs: number[] | undefined;
  (db as unknown as { $on(name: "query", callback: (e: { query: string }) => void): void }).$on("query", e =>
    sql?.push(e.query.replace(/\s+/g, " ").trim()));
  function observe(target: object, prefix = ""): object {
    return new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key);
      if (key === "$transaction") return async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => {
        const start = performance.now();
        try { return await db.$transaction(tx => fn(observe(tx) as Prisma.TransactionClient), options); }
        finally { txMs?.push(performance.now() - start); }
      };
      if (typeof value === "function") return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(value, object, args);
        const method = prefix + String(key);
        const count = Array.isArray(result) ? result.length : result === null ? 0 :
          typeof result === "object" && "count" in result ? Number(result.count) : typeof result === "object" ? 1 : null;
        calls?.push({ method, returned: count, affected: /\.(create|update|upsert|delete)/.test(method) ? count ?? 0 : 0,
          select: args[0] && typeof args[0] === "object" && "select" in args[0] ? args[0].select : null });
        return result;
      };
      if (value && typeof value === "object" && !String(key).startsWith("_")) return observe(value, String(key) + ".");
      return value;
    } });
  }
  const port = observe(db) as PrismaClient;
  const shapes = new Map<string, number>(); const shapeId = (shape: string) => {
    if (!shapes.has(shape)) shapes.set(shape, shapes.size + 1);
    return shapes.get(shape)!;
  };
  const profiles = ["create-new", "create-replay", "cancel-new", "cancel-replay", "switch-new", "switch-replay",
    "purchase-new", "purchase-replay", "history-1-blocked", "history-1000-blocked", "history-1-clear", "history-1000-clear",
    "recurring-winner", "recurring-loser", "purchase-winner", "purchase-loser"];
  const samples: object[] = [];
  for (const profile of profiles) for (let sample = -2; sample < 5; sample++) {
    const kind: Kind = profile.startsWith("purchase") ? "purchase" : profile.startsWith("cancel") ? "cancel" :
      profile.startsWith("switch") ? "switch" : "create";
    const f = await fixture("m15-" + profile + "-" + (sample + 2), kind);
    // Source and candidate use exactly the same real-authenticated, warm fixture.
    let providerCalls = 0;
    const h = createHash("md5").update(f.id).digest("hex");
    const chargeId = h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
    const deterministicProvider = {
      createSubscription: async () => { providerCalls++; return { id: f.id + "-provider", confirmation_url: "https://woocommerce.com/checkout/fixed" }; },
      switchSubscription: async (id: string) => { providerCalls++; return { id, confirmation_url: "https://woocommerce.com/checkout/fixed" }; },
      cancelSubscription: async () => { providerCalls++; },
      createCharge: async () => { providerCalls++; return { id: chargeId, confirmation_url: "https://woocommerce.com/checkout/fixed" }; },
    };
    const recurring = new Recurring(port, deterministicProvider, "production");
    const credit = new Credit(port, deterministicProvider, "production");
    const operation = () => kind === "create" ? recurring.create(f.principal, "measurement-key", f.c.target.id) :
      kind === "switch" ? recurring.switchPlan(f.principal, "measurement-key", f.c.target.id) :
      kind === "cancel" ? recurring.cancel(f.principal, "measurement-key") : credit.initiate(f.principal, "measurement-key", f.c.bundle);
    if (profile.endsWith("replay")) await operation();
    if (profile.startsWith("history")) {
      const count = profile.includes("1000") ? 1000 : 1;
      await db.billingOperation.createMany({ data: Array.from({ length: count }, (_, i) => ({
        id: f.id + "-history-" + i, shopId: f.id, requestKey: "history-" + i,
        kind: "CANCEL" as const, state: profile.endsWith("blocked") && i === 0 ? "INITIATING" as const : "FAILED" as const,
        requestFingerprint: Buffer.alloc(32), providerReference: f.id + "-history-contract",
        lastErrorCode: profile.endsWith("blocked") && i === 0 ? null : "PROVIDER_REJECTED",
        createdAt: new Date(clock.getTime() + i), updatedAt: clock,
      })) });
    }
    let admitted: BillingOperation | undefined;
    if (profile.includes("winner") || profile.includes("loser")) {
      admitted = kind === "purchase"
        ? (await new RecoveryCreditIntentPersistence(db).persistIntent(f.principal, "outcome-key", f.c.bundle)).operation
        : (await new RecurringIntentPersistence(db, new InitialWooFreeActivationService()).persistIntent(
          f.principal, "SUBSCRIPTION_CREATE", "outcome-key", f.c.target.id)).operation;
      if (profile.endsWith("loser")) await competitor.billingOperation.update({ where: { id: admitted.id }, data: {
        state: "CONFIRMED", providerReference: kind === "purchase" ? chargeId : f.id + "-provider",
        confirmationUrl: "https://woocommerce.com/checkout/winner",
      } });
    }
    const before = await snapshot(f); const initialCalls = providerCalls;
    calls = []; sql = []; txMs = [];
    const start = performance.now();
    let result: unknown; let failure: unknown;
    try {
      if (admitted) {
        if (kind === "purchase") result = await new CreditOutcome(port, "production").confirmProviderOperation(admitted, {
          id: chargeId, confirmationUrl: "https://woocommerce.com/checkout/fixed",
        });
        else result = await new Outcome(port, "production").confirmSubscription(admitted, {
          id: f.id + "-provider", confirmationUrl: "https://woocommerce.com/checkout/fixed",
        });
      } else result = await operation();
    } catch (error) { failure = error; }
    const elapsedMs = performance.now() - start;
    const observed = calls; const statements = sql; const transactions = txMs;
    calls = undefined; sql = undefined; txMs = undefined;
    const afterState = await snapshot(f);
    const blocked = profile.endsWith("blocked");
    if (blocked) {
      assert.equal((failure as { code: string })?.code, "billing_operation_conflict");
      assert.deepEqual(afterState, before); assert.equal(providerCalls, initialCalls);
    } else {
      assert.equal(failure, undefined);
      assert.ok(result && typeof result === "object" && "state" in result);
      assert.equal(result.state, profile.endsWith("loser") || kind === "cancel" ? "CONFIRMED" : "AWAITING_CONFIRMATION");
      assert.equal(providerCalls - initialCalls, admitted || profile.endsWith("replay") ? 0 : 1);
      assert.deepEqual(afterState.subscription, before.subscription);
      const saved = afterState.operations.find(row => row.requestKey === (admitted ? "outcome-key" : "measurement-key"))!;
      assert.equal(saved.quotedAmountMinor, kind === "cancel" ? null : kind === "purchase" ? 1200 : 4900);
      assert.equal(saved.quotedCurrency, kind === "cancel" ? null : "USD");
      if (kind !== "cancel" && kind !== "purchase") assert.equal(saved.quotedBillingPeriod, "EVERY_30_DAYS");
      for (const row of afterState.purchases) { assert.equal(row.currentAmount, 0); assert.equal(row.status, "REQUESTED"); }
      if (profile.endsWith("replay")) assert.deepEqual(afterState, before);
    }
    if (sample >= 0) {
      const record = {
      profile, sample: sample + 1, fixture: f.id, elapsedMs, transactionMs: transactions,
      calls: observed, sql: statements.map(shapeId), providerCalls: providerCalls - initialCalls,
      operationRowsBefore: before.operations.length, operationRowsAfter: afterState.operations.length,
      purchaseRowsBefore: before.purchases.length, purchaseRowsAfter: afterState.purchases.length,
      retries: Math.max(0, transactions.length - (admitted || blocked || profile.endsWith("replay") ? 1 : 2)), rollbackStatements: statements.filter(s => s === "ROLLBACK").length,
      wireBytes: "not measured", triggerWork: "not measured",
      };
      samples.push(record);
      process.stdout.write("ARCH055_BILLING_SAMPLE " + JSON.stringify(record) + "\n");
    }
  }
  // Reproduce the original authentication/admission gap separately from samples.
  const race = await fixture("baseline-admission-proof", "create");
  const gate = barrier(); let raceCalls = 0;
  const provider = {
    createSubscription: async () => { raceCalls++; return { id: race.id + "-provider", confirmation_url: "https://woocommerce.com/checkout/fixed" }; },
    switchSubscription: async () => { throw new Error("unexpected switch"); },
    cancelSubscription: async () => { throw new Error("unexpected cancel"); },
  };
  const source = new Recurring(db, async () => { await gate.pause(); return provider; }, "production");
  const pending = source.create(race.principal, "race-proof", race.c.target.id).then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    await competitor.wooCommerceInstallation.update({ where: { id: race.installation.id }, data: { credentialVersion: { increment: 1 } } });
  } finally { gate.release(); }
  const raceResult = await pending;
  if (measuring === "baseline") {
    assert.ok("value" in raceResult); assert.equal(raceCalls, 1);
    assert.equal(await db.billingOperation.count({ where: { shopId: race.id } }), 1);
  } else {
    assert.ok("error" in raceResult); assert.equal(raceResult.error.code, "billing_shop_invalid");
    assert.equal(raceCalls, 0); assert.equal(await db.billingOperation.count({ where: { shopId: race.id } }), 0);
  }
  process.stdout.write("ARCH055_BILLING_MEASURE " + JSON.stringify({
    version: measuring, root, admissionProof: { providerCalls: raceCalls, operationRows: await db.billingOperation.count({ where: { shopId: race.id } }) }, samples, shapes: Object.fromEntries([...shapes].map(([shape, id]) => [id, shape])),
  }) + "\n");
});

test("ARCH-055 G03 confirmed cancellation respects contract and terminal Free exceptions", { skip: !url || !!measuring }, async () => {
  for (const variant of ["free-reset", "different-contract", "same-contract", "cancel-flag"] as const) {
    const f = await fixture("blocker-" + variant, variant === "free-reset" ? "create" : "switch");
    if (variant === "cancel-flag") await db.subscription.update({ where: { shopId: f.id }, data: { cancelAtPeriodEnd: true } });
    await db.billingOperation.create({ data: {
      shopId: f.id, kind: "CANCEL", state: "CONFIRMED", requestKey: "old-cancel",
      requestFingerprint: Buffer.alloc(32), providerReference: variant === "same-contract" ? f.subscription.providerSubscriptionId! : f.id + "-old-contract",
    } });
    const s = services(db, f);
    if (variant === "same-contract" || variant === "cancel-flag") {
      await assert.rejects(invoke(f, s), (error: unknown) => !!error && typeof error === "object" &&
        "code" in error && error.code === "billing_operation_conflict");
      assert.equal(s.count(), 0);
    } else {
      assert.equal((await invoke(f, s)).state, "AWAITING_CONFIRMATION"); assert.equal(s.count(), 1);
    }
  }
});
