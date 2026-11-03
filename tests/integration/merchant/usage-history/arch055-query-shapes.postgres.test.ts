import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import { MerchantUsageHistoryService } from "../../../../src/merchant/usage-history/history.service.js";
import type { UsageHistoryQuery } from "../../../../src/merchant/usage-history/contract.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
type QueryLoggingClient = PrismaClient & {
  $on(event: "query", callback: (event: Prisma.QueryEvent) => void): void;
};
let prisma: QueryLoggingClient | undefined;
let shopId: string | undefined;
let planId: string | undefined;

function database(): QueryLoggingClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  return prisma ??= new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [{ level: "query", emit: "event" }],
  }) as QueryLoggingClient;
}

after(async () => {
  if (!prisma) return;
  if (shopId) {
    await prisma.usageReservation.deleteMany({ where: { shopId } });
    await prisma.usageEvent.deleteMany({ where: { shopId } });
    await prisma.subscription.deleteMany({ where: { shopId } });
    await prisma.shop.deleteMany({ where: { id: shopId } });
  }
  if (planId) await prisma.billingPlan.deleteMany({ where: { id: planId } });
  await prisma.$disconnect();
});

const query: UsageHistoryQuery = {
  view: "current", periodId: null, kind: "RECOVERY_CONVERSATION", page: 1, pageSize: 10, periodCursor: null,
};

test("PostgreSQL usage history reads count and signed quantity in one aggregate", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const statements: string[] = [];
  db.$on("query", (event) => statements.push(event.query));
  const plan = await db.billingPlan.create({
    data: { name: `Usage query ${suffix}`, shopifyPlanHandle: `usage-query-${suffix}`, kind: "FREE" },
  });
  planId = plan.id;
  const shop = await db.shop.create({
    data: { domain: `https://usage-query-${suffix}.invalid`, platform: "WOOCOMMERCE", onboardingCompleted: true },
  });
  shopId = shop.id;
  const installation = await db.wooCommerceInstallation.create({
    data: { shopId: shop.id, canonicalSiteUrl: shop.domain, credentialDigest: Buffer.alloc(32, 54) },
  });
  await db.subscription.create({ data: { shopId: shop.id, status: "ACTIVE", planId: plan.id } });
  await db.usageEvent.create({ data: {
    shopId: shop.id,
    metric: "RECOVERY_CONVERSATION",
    quantity: new Prisma.Decimal("2"),
    provider: "WOOCOMMERCE",
    sourceType: "FREE_RECOVERY_RESERVATION",
    idempotencyKey: `usage-query-${suffix}`,
  } });
  const start = statements.length;

  const result = await new MerchantUsageHistoryService(db).read({
    installationId: installation.id,
    shopId: shop.id,
    canonicalSiteUrl: shop.domain,
    credentialVersion: installation.credentialVersion,
  }, query);

  assert.equal(result.usagePagination.total, 1);
  assert.equal(result.usagePagination.totalQuantity, 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const aggregateSelects = statements.slice(start).filter((sql) =>
    /SELECT/i.test(sql) && /COUNT\s*\(/i.test(sql) && /SUM\s*\(/i.test(sql));
  assert.equal(aggregateSelects.length, 1,
    statements.slice(start).map((sql) => sql.replace(/\s+/g, " ").slice(0, 400)).join(" | "));
  const separateCounts = statements.slice(start).filter((sql) =>
    /SELECT/i.test(sql) && /COUNT\s*\(/i.test(sql) && !/SUM\s*\(/i.test(sql));
  assert.deepEqual(separateCounts, []);
});

test("PostgreSQL usage history preserves the M13 30-period signed v1/v2 projection", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const suffix = randomUUID().replaceAll("-", "");
  const plan = await db.billingPlan.create({
    data: { name: `Usage M13 ${suffix}`, shopifyPlanHandle: `usage-m13-${suffix}`, kind: "PAID_METERED" },
  });
  const shop = await db.shop.create({
    data: { domain: `https://usage-m13-${suffix}.invalid`, platform: "WOOCOMMERCE", onboardingCompleted: true },
  });
  const installation = await db.wooCommerceInstallation.create({
    data: { shopId: shop.id, canonicalSiteUrl: shop.domain, credentialDigest: Buffer.alloc(32, 55) },
  });
  const principal = {
    installationId: installation.id,
    shopId: shop.id,
    canonicalSiteUrl: shop.domain,
    credentialVersion: installation.credentialVersion,
  };
  const subscription = await db.subscription.create({
    data: { shopId: shop.id, status: "ACTIVE", planId: plan.id },
  });
  const currentStart = new Date("2026-10-01T00:00:00.000Z");
  const currentEnd = new Date("2026-10-31T00:00:00.000Z");
  const currentPeriod = await db.billingPeriod.create({
    data: {
      shopId: shop.id,
      subscriptionId: subscription.id,
      planId: plan.id,
      planKindSnapshot: "PAID_METERED",
      periodStart: currentStart,
      periodEnd: currentEnd,
      status: "OPEN",
    },
  });
  await db.subscription.update({
    where: { id: subscription.id },
    data: { billingPeriodId: currentPeriod.id, currentPeriodStart: currentStart, currentPeriodEnd: currentEnd },
  });
  const periods = [];
  for (let rank = 1; rank <= 30; rank += 1) {
    const periodStart = new Date(currentStart.getTime() - rank * 30 * 24 * 60 * 60 * 1000);
    periods.push(await db.billingPeriod.create({
      data: {
        shopId: shop.id,
        subscriptionId: subscription.id,
        planId: plan.id,
        planKindSnapshot: "PAID_METERED",
        periodStart,
        periodEnd: new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000),
        status: "CLOSED",
      },
    }));
  }
  const allPeriods = [currentPeriod, ...periods];
  for (const [periodIndex, period] of allPeriods.entries()) {
    const baseEvents = Array.from({ length: 29 }, (_, eventIndex) => ({
      id: `usage-m13-${suffix}-${periodIndex}-${eventIndex}`,
      shopId: shop.id,
      metric: "RECOVERY_CONVERSATION" as const,
      quantity: new Prisma.Decimal("2"),
      provider: "WOOCOMMERCE",
      sourceType: "PURCHASED_RECOVERY_CREDITS",
      billingPeriodId: period.id,
      occurredAt: new Date(period.periodStart.getTime() + eventIndex * 1_000),
      idempotencyKey: `usage-m13-${suffix}-${periodIndex}-${eventIndex}`,
    }));
    await db.usageEvent.createMany({ data: [
      ...baseEvents,
      ...[0, 1].map((eventIndex) => ({
        id: `usage-m13-${suffix}-${periodIndex}-correction-${eventIndex}`,
        shopId: shop.id,
        metric: "RECOVERY_CONVERSATION" as const,
        quantity: new Prisma.Decimal("-1"),
        provider: "WOOCOMMERCE",
        sourceType: "PAID_CORRECTION",
        billingPeriodId: period.id,
        correctionOfUsageEventId: baseEvents[eventIndex]!.id,
        occurredAt: new Date((periodIndex === 0 ? period.periodStart.getTime() + 30_000 : period.periodEnd.getTime()) + eventIndex * 1_000),
        idempotencyKey: `usage-m13-${suffix}-${periodIndex}-correction-${eventIndex}`,
      })),
    ] });
  }

  const service = new MerchantUsageHistoryService(db, () => new Date("2026-10-15T12:00:00.000Z"));
  const statements: string[] = [];
  db.$on("query", (event) => statements.push(event.query));
  const readAndAssert = async (input: UsageHistoryQuery, periodSelectCount: number) => {
    const start = statements.length;
    const result = await service.read(principal, input);
    const observed = statements.slice(start);
    const aggregates = observed.filter((sql) =>
      /SELECT/i.test(sql) && /COUNT\s*\(/i.test(sql) && /SUM\s*\(/i.test(sql));
    const periodSelects = observed.filter((sql) =>
      /SELECT/i.test(sql) && /"billing"\."BillingPeriod"/i.test(sql));
    assert.equal(aggregates.length, 1);
    assert.equal(periodSelects.length, periodSelectCount);
    assert.equal(result.usagePagination.total, 31);
    assert.equal(result.usagePagination.totalQuantity, 56);
    assert.equal(result.usageEvents.length, 31);
    return result;
  };

  try {
    await readAndAssert({ ...query, pageSize: 50 }, 1);
    const defaultPast = await service.read(principal, { ...query, view: "past", pageSize: 50 });
    assert.equal(defaultPast.periodPage.items.length, 25);
    assert.equal(defaultPast.usagePagination.total, 31);
    assert.equal(defaultPast.usagePagination.totalQuantity, 56);
    await readAndAssert({ ...query, pageSize: 50, responseVersion: 2 }, 1);
    await readAndAssert({ ...query, view: "past", pageSize: 50, responseVersion: 2 }, 1);
    const rankTwoV1 = await readAndAssert({ ...query, view: "past", periodId: periods[1]!.id, pageSize: 50 }, 1);
    assert.equal(rankTwoV1.usagePagination.billId, periods[1]!.id);
    const rankThirtyV1 = await readAndAssert({ ...query, view: "past", periodId: periods[29]!.id, pageSize: 50 }, 2);
    assert.equal(rankThirtyV1.usagePagination.billId, periods[29]!.id);
    const rankTwoV2 = await readAndAssert({
      ...query, view: "past", periodId: periods[1]!.id, pageSize: 50, responseVersion: 2,
    }, 1);
    assert.equal(rankTwoV2.schemaVersion, 2);
    assert.ok(rankTwoV2.usageEvents.every((event) => event.chargedAgainst === "UNATTRIBUTED"));
    const rankThirtyV2 = await readAndAssert({
      ...query, view: "past", periodId: periods[29]!.id, pageSize: 50, responseVersion: 2,
    }, 2);
    assert.equal(rankThirtyV2.schemaVersion, 2);
    assert.deepEqual(rankThirtyV2.usageEvents.map((event) => event.quantity).sort((a, b) => a - b),
      [-1, -1, ...Array.from({ length: 29 }, () => 2)]);
  } finally {
    await db.usageEvent.deleteMany({ where: { shopId: shop.id } });
    await db.billingPeriod.deleteMany({ where: { shopId: shop.id } });
    await db.subscription.deleteMany({ where: { shopId: shop.id } });
    await db.wooCommerceInstallation.deleteMany({ where: { shopId: shop.id } });
    await db.shop.delete({ where: { id: shop.id } });
    await db.billingPlan.delete({ where: { id: plan.id } });
  }
});
