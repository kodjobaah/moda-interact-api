import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  MerchantUsageHistoryService, usageWhere,
} from "../../../../src/merchant/usage-history/history.service.js";
import { UsageHistoryIntegrityError, UsageHistoryRequestError, type UsageHistoryQuery } from "../../../../src/merchant/usage-history/contract.js";

const now = new Date("2026-10-22T10:00:00.000Z");
const principal = { installationId: "install_a", shopId: "shop_a", canonicalSiteUrl: "https://a.test", credentialVersion: 1 };
const query: UsageHistoryQuery = { view: "current", kind: "ALL", page: 1, pageSize: 10, periodId: null, periodCursor: null };
const paidPeriod = {
  id: "period_a", shopId: "shop_a", subscriptionId: "sub_a", planKindSnapshot: "PAID_METERED",
  periodStart: new Date("2026-10-01T00:00:00.000Z"),
  periodEnd: new Date("2026-10-31T00:00:00.000Z"), status: "OPEN",
};

function fixture(config: {
  paid?: boolean;
  subscription?: "missing" | "cancelled";
  closedPeriod?: typeof paidPeriod;
  period?: object | null;
  shop?: object;
  installation?: object;
  rows?: Array<Record<string, unknown>>;
  periodRows?: object[];
  recoveryRows?: object[];
  reservationRows?: object[];
  reservationError?: Error;
} = {}) {
  const queries: Array<{ operation: string; args: unknown }> = [];
  const sub = { id: "sub_a", shopId: principal.shopId,
    plan: { kind: config.paid ? "PAID_METERED" : "FREE" },
    billingPeriodId: config.paid ? "period_a" : null,
    currentPeriodStart: config.paid ? paidPeriod.periodStart : null,
    currentPeriodEnd: config.paid ? paidPeriod.periodEnd : null,
    ...(config.subscription === "cancelled" ? {
      status: "NO_CONTRACT", plan: null, billingPeriodId: null,
      currentPeriodStart: null, currentPeriodEnd: null,
    } : {}),
  };
  const rows = config.rows ?? [{ id: "usage_a", metric: "RECOVERY_CONVERSATION",
    quantity: new Prisma.Decimal(2), occurredAt: now, sourceId: "recovery_a" }];
  const tx = {
    shop: { findUnique: async () => config.shop ?? {
      id: principal.shopId, domain: principal.canonicalSiteUrl, platform: "WOOCOMMERCE",
      shopifyShopId: null, status: "ACTIVE", onboardingCompleted: true,
    } },
    wooCommerceInstallation: { findUnique: async () => config.installation ?? {
      shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
      credentialVersion: principal.credentialVersion, credentialDigest: Buffer.alloc(32, 5),
      status: "ACTIVE", revokedAt: null,
    } },
    subscription: { findUnique: async () => config.subscription === "missing" ? null : sub },
    billingPeriod: {
      findFirst: async ({ where }: { where: { id?: string; status?: string } }) => {
        if (where.status === "CLOSED") {
          return config.closedPeriod?.id === where.id ? config.closedPeriod : null;
        }
        return config.period === undefined ? (config.paid ? paidPeriod : null) : config.period;
      },
      findMany: async (args: unknown) => {
        queries.push({ operation: "periods", args });
        return config.periodRows ?? [];
      },
    },
    usageEvent: {
      findMany: async (args: unknown) => { queries.push({ operation: "findMany", args }); return rows; },
      count: async (args: unknown) => { queries.push({ operation: "count", args }); return rows.length; },
      aggregate: async (args: unknown) => { queries.push({ operation: "aggregate", args });
        return { _sum: { quantity: rows.reduce((n, item) => n.plus(item.quantity as Prisma.Decimal), new Prisma.Decimal(0)) } }; },
    },
    checkoutRecovery: {
      findMany: async (args: unknown) => { queries.push({ operation: "sources", args }); return config.recoveryRows ?? []; },
    },
    usageReservation: {
      findMany: async (args: unknown) => {
        queries.push({ operation: "reservations", args });
        if (config.reservationError) throw config.reservationError;
        return config.reservationRows ?? [];
      },
    },
  };
  const database = { $transaction: async (run: (transaction: typeof tx) => Promise<unknown>, options: unknown) => {
    queries.push({ operation: "transaction", args: options });
    return run(tx);
  } };
  return { service: new MerchantUsageHistoryService(database as never, () => now), queries };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("Free lifetime uses genuine unperiodised recovery and credit-pool events, no fictional bill ID", async () => {
  const { service, queries } = fixture({ rows: [{ id: "free_1", metric: "RECOVERY_CONVERSATION",
    quantity: new Prisma.Decimal("2"), occurredAt: now, sourceId: null }] });
  const result = await service.read(principal, query);
  assert.equal(result.state, "ready");
  assert.deepEqual(result.periodPage.items, []);
  assert.equal(result.usagePagination.billId, null);
  assert.equal(result.usagePagination.total, 1);
  assert.equal(result.usagePagination.totalQuantity, 2);
  const where = record(record(queries.find((q) => q.operation === "findMany")?.args).where);
  assert.equal(where.shopId, principal.shopId);
  assert.equal(where.provider, "WOOCOMMERCE");
  assert.equal(where.billingPeriodId, null);
  const branches = where.OR;
  assert.ok(Array.isArray(branches));
  assert.deepEqual(record(record(branches[0]).sourceType).in,
    ["FREE_RECOVERY_RESERVATION", "PURCHASED_RECOVERY_CREDITS", "PROMOTIONAL_RECOVERY_CREDITS"]);
  assert.deepEqual(queries[0]?.args, { isolationLevel: "RepeatableRead" });
});

test("paid current respects 30-day Moda period, stable event page offset and safe same-Shop links", async () => {
  const { service, queries } = fixture({ paid: true, rows: [
    { id: "usage_a", metric: "RECOVERY_CONVERSATION", quantity: new Prisma.Decimal("2"), occurredAt: now, sourceId: "recovery_a" },
    { id: "usage_b", metric: "RECOVERY_CONVERSATION", quantity: new Prisma.Decimal("-1"), occurredAt: now, sourceId: "recovery_foreign" },
  ], recoveryRows: [{ id: "recovery_a", shopId: "shop_a", customer: {
    shopId: "shop_a", firstName: "Jane", lastName: "Merchant",
  }, conversation: null }] });
  const result = await service.read(principal, { ...query, kind: "RECOVERY_CONVERSATION", page: 3, pageSize: 25 });
  assert.equal(result.usagePagination.billId, paidPeriod.id);
  assert.equal(result.usagePagination.totalQuantity, 1);
  assert.deepEqual(result.usageEvents.map((row) => row.quantity), [2, -1]);
  assert.deepEqual(result.usageEvents.map((row) => row.sourceRecovery), [
    { recoveryId: "recovery_a", customerName: "Jane Merchant" }, null,
  ]);
  const args = record(queries.find((q) => q.operation === "findMany")?.args);
  assert.equal(args.skip, 50);
  assert.equal(args.take, 25);
  assert.deepEqual(args.orderBy, [{ occurredAt: "desc" }, { id: "desc" }]);
  const where = record(args.where);
  const branches = where.OR;
  assert.ok(Array.isArray(branches));
  assert.deepEqual(branches[0], { billingPeriodId: "period_a" });
  assert.deepEqual(record(branches[1]).occurredAt,
    { gte: paidPeriod.periodStart, lt: paidPeriod.periodEnd });
  assert.equal(where.provider, "WOOCOMMERCE");
  assert.equal(where.metric, "RECOVERY_CONVERSATION");
  assert.equal(JSON.stringify(result).includes("sourceId"), false);
});

test("missing subscription is unavailable, not a fabricated empty Free lifetime", async () => {
  const { service, queries } = fixture({ subscription: "missing" });
  const result = await service.read(principal, query);
  assert.equal(result.state, "unavailable");
  assert.equal(result.usagePagination.billId, null);
  assert.equal(queries.some((q) => q.operation === "findMany"), false);
});

test("paid without a qualifying current period is explicit unavailable and queries no usage records", async () => {
  const { service, queries } = fixture({ paid: true, period: { ...paidPeriod, periodEnd: new Date("2026-10-20T00:00:00Z") } });
  const result = await service.read(principal, query);
  assert.equal(result.state, "unavailable");
  assert.equal(result.usagePagination.billId, null);
  assert.equal(queries.some((q) => q.operation === "findMany"), false);
});

test("foreign/mismatched period and wrong-platform/rotated installation fail closed", async () => {
  const { service } = fixture({ paid: true });
  await assert.rejects(service.read(principal, { ...query, periodId: "period_foreign" }),
    (err: unknown) => err instanceof UsageHistoryRequestError && err.code === "invalid_period");
  for (const item of [
    fixture({ shop: { id: principal.shopId, domain: principal.canonicalSiteUrl, platform: "SHOPIFY",
      shopifyShopId: "gid://shopify/Shop/1", status: "ACTIVE", onboardingCompleted: true } }),
    fixture({ installation: { shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
      status: "REVOKED", revokedAt: new Date(), credentialVersion: 1, credentialDigest: Buffer.alloc(32, 5) } }),
    fixture({ installation: { shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
      status: "ACTIVE", revokedAt: null, credentialVersion: 9, credentialDigest: Buffer.alloc(32, 5) } }),
  ]) await assert.rejects(item.service.read(principal, query), UsageHistoryIntegrityError);
});

test("usageWhere permits only Woo provider and signed corrections to matching original period", () => {
  const where = usageWhere("shop_a", query, paidPeriod as never, false);
  assert.equal(where.shopId, "shop_a");
  assert.equal(where.provider, "WOOCOMMERCE");
  const branches = where.OR;
  assert.ok(Array.isArray(branches));
  const correction = record(record(branches[2]).correctionOfUsageEvent);
  const targets = record(correction.is).OR;
  assert.ok(Array.isArray(targets));
  assert.deepEqual(targets[0], { billingPeriodId: "period_a" });
});


test("cancelled paid subscription retains CLOSED period history, not a fictional current period", async () => {
  const closed = { ...paidPeriod, status: "CLOSED" };
  const { service, queries } = fixture({
    subscription: "cancelled", closedPeriod: closed, periodRows: [closed],
    rows: [
      { id: "correction", metric: "RECOVERY_CONVERSATION", quantity: new Prisma.Decimal("-1"),
        occurredAt: new Date("2026-11-02T12:00:00.000Z"), sourceId: null },
      { id: "debit", metric: "RECOVERY_CONVERSATION", quantity: new Prisma.Decimal("3"),
        occurredAt: new Date("2026-10-05T12:00:00.000Z"), sourceId: null },
    ],
  });

  const current = await service.read(principal, query);
  assert.equal(current.state, "unavailable");
  assert.deepEqual(current.periodPage.items, []);
  assert.equal(current.usagePagination.billId, null);
  assert.equal(queries.some(({ operation }) => operation === "findMany"), false);

  const past = await service.read(principal, { ...query, view: "past", periodId: closed.id });
  assert.equal(past.state, "ready");
  assert.deepEqual(past.periodPage.items.map(({ id }) => id), [closed.id]);
  assert.equal(past.usagePagination.billId, closed.id);
  assert.equal(past.usagePagination.total, 2);
  assert.equal(past.usagePagination.totalQuantity, 2);
  assert.deepEqual(past.usageEvents.map(({ quantity }) => quantity), [-1, 3]);
  const periodsQuery = record(queries.find(({ operation }) => operation === "periods")?.args);
  assert.deepEqual(record(periodsQuery.where), { shopId: principal.shopId, status: "CLOSED" });
  const usageQuery = record(queries.find(({ operation }) => operation === "findMany")?.args);
  const where = record(usageQuery.where);
  assert.equal(where.shopId, principal.shopId);
  assert.equal(where.provider, "WOOCOMMERCE");
  assert.deepEqual(record((where.OR as unknown[])[0]), { billingPeriodId: closed.id });
});


test("v1 stays byte-shape compatible and v2 exposes only verified reservation allocation", async () => {
  const rows = [{ id: "usage_a", metric: "RECOVERY_CONVERSATION", billingPeriodId: null,
    correctionOfUsageEventId: null, quantity: new Prisma.Decimal(1), occurredAt: now, sourceId: null }];
  const { service, queries } = fixture({ rows, reservationRows: [{
    shopId: "shop_a", status: "COMMITTED", committedUsageEventId: "usage_a", compensationUsageEventId: null,
    counterId: "counter_free", counter: { shopId: "shop_a", counter: "LIFETIME_FREE_RECOVERY_CREDITS" },
    billingPeriodEntitlementCounterId: null, billingPeriodEntitlementCounter: null,
    purchasedCreditPurchaseId: null, purchasedCreditPurchase: null,
    promotionalCreditGrantId: null, promotionalCreditGrant: null,
  }] });
  const old = await service.read(principal, query);
  assert.equal(old.schemaVersion, 1);
  assert.equal(JSON.stringify(old).includes("chargedAgainst"), false);
  assert.equal(queries.some((q) => q.operation === "reservations"), false);
  const attributed = await service.read(principal, { ...query, responseVersion: 2 });
  assert.equal(attributed.schemaVersion, 2);
  assert.deepEqual(attributed.usageEvents.map((row) => ("chargedAgainst" in row ? row.chargedAgainst : null)),
    ["LIFETIME_FREE_CREDITS"]);
  assert.equal(queries.some((q) => q.operation === "reservations"), true);
  assert.equal(JSON.stringify(attributed).includes("counter_free"), false);
});

test("unavailable v2 response includes no events and preserves no-billing-period semantics", async () => {
  const { service, queries } = fixture({ subscription: "missing" });
  const result = await service.read(principal, { ...query, responseVersion: 2 });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.state, "unavailable");
  assert.deepEqual(result.usageEvents, []);
  assert.equal(queries.some((q) => q.operation === "reservations"), false);
});


test("v2 allocation query failures propagate instead of returning misleading UNATTRIBUTED results", async () => {
  const failure = new Error("usage-reservation-read-failed");
  const { service, queries } = fixture({ rows: [{ id: "usage_a", metric: "RECOVERY_CONVERSATION",
    billingPeriodId: null, correctionOfUsageEventId: null, quantity: new Prisma.Decimal(1),
    occurredAt: now, sourceId: null }], reservationError: failure });
  await assert.rejects(service.read(principal, { ...query, responseVersion: 2 }),
    (error: unknown) => error === failure);
  assert.equal(queries.some((entry) => entry.operation === "reservations"), true);
  const legacy = await service.read(principal, query);
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.usageEvents.length, 1);
});
