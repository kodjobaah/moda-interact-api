import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { MerchantUsageHistoryService } from "../../../../src/merchant/usage-history/history.service.js";
import { UsageHistoryIntegrityError, UsageHistoryRequestError, type UsageHistoryQuery } from "../../../../src/merchant/usage-history/contract.js";

const url = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const now = new Date("2026-10-22T12:00:00.000Z");
const query: UsageHistoryQuery = {
  view: "current", periodId: null, kind: "RECOVERY_CONVERSATION", page: 1, pageSize: 10, periodCursor: null,
};

/** Run only inside the disposable PostgreSQL/pgvector test harness. */
test("API-022 PostgreSQL: Free, paid, purchased/promo, signed corrections, paging and Shop boundaries", {
  skip: !url,
}, async () => {
  if (!url) return;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const suffix = randomUUID().replaceAll("-", "");
  const shops: string[] = [];
  const plans: string[] = [];
  const service = new MerchantUsageHistoryService(db, () => now);
  let serial = 0;
  const event = (shopId: string, quantity: string, other: Record<string, unknown> = {}) => ({
    shopId, metric: "RECOVERY_CONVERSATION" as const, quantity: new Prisma.Decimal(quantity),
    provider: "WOOCOMMERCE", idempotencyKey: `arch035-api022-${suffix}-${++serial}`, ...other,
  });
  try {
    const freePlan = await db.billingPlan.create({ data: {
      name: `Free ${suffix}`, shopifyPlanHandle: `arch035-free-${suffix}`, kind: "FREE",
    } });
    const paidPlan = await db.billingPlan.create({ data: {
      name: `Paid ${suffix}`, shopifyPlanHandle: `arch035-paid-${suffix}`, kind: "PAID_METERED",
    } });
    plans.push(freePlan.id, paidPlan.id);
    const shop = await db.shop.create({ data: {
      domain: `https://woo-${suffix}.test.invalid`, platform: "WOOCOMMERCE", onboardingCompleted: true,
    } });
    const other = await db.shop.create({ data: {
      domain: `https://foreign-${suffix}.test.invalid`, platform: "WOOCOMMERCE", onboardingCompleted: true,
    } });
    shops.push(shop.id, other.id);
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain, credentialDigest: Buffer.alloc(32, 42),
    } });
    const principal = { shopId: shop.id, canonicalSiteUrl: shop.domain,
      installationId: installation.id, credentialVersion: installation.credentialVersion };
    const sub = await db.subscription.create({ data: {
      shopId: shop.id, status: "ACTIVE", planId: freePlan.id,
    } });
    const ownCustomer = await db.customer.create({ data: {
      shopId: shop.id, firstName: "Same", lastName: "Shop",
    } });
    const foreignCustomer = await db.customer.create({ data: {
      shopId: other.id, firstName: "Other", lastName: "Shop",
    } });
    const ownedRecovery = await db.checkoutRecovery.create({ data: {
      shopId: shop.id, customerId: ownCustomer.id, checkoutToken: `own-${suffix}`,
      lastExternalActivityAt: now,
    } });
    const foreignRecovery = await db.checkoutRecovery.create({ data: {
      shopId: other.id, customerId: foreignCustomer.id, checkoutToken: `foreign-${suffix}`,
      lastExternalActivityAt: now,
    } });
    const freeDebit = await db.usageEvent.create({ data: event(shop.id, "2", {
      sourceType: "FREE_RECOVERY_RESERVATION", sourceId: ownedRecovery.id,
      occurredAt: new Date("2026-09-10T10:00:00.000Z"),
    }) });
    await db.usageEvent.create({ data: event(shop.id, "-1", {
      correctionOfUsageEventId: freeDebit.id, sourceType: "FREE_CORRECTION",
      occurredAt: new Date("2026-09-11T10:00:00.000Z"),
    }) });
    await db.usageEvent.create({ data: event(shop.id, "3", {
      sourceType: "PROMOTIONAL_RECOVERY_CREDITS", sourceId: foreignRecovery.id,
      occurredAt: new Date("2026-09-12T10:00:00.000Z"),
    }) });
    await db.usageEvent.create({ data: {
      ...event(shop.id, "500", { sourceType: "FREE_RECOVERY_RESERVATION" }), provider: "SHOPIFY",
    } });
    await db.usageEvent.create({ data: event(other.id, "1000", { sourceType: "FREE_RECOVERY_RESERVATION" }) });
    const freeHistory = await service.read(principal, query);
    assert.equal(freeHistory.state, "ready");
    assert.equal(freeHistory.usagePagination.billId, null);
    assert.equal(freeHistory.usagePagination.total, 3);
    assert.equal(freeHistory.usagePagination.totalQuantity, 4);
    assert.equal(freeHistory.usageEvents.find((x) => x.id === freeDebit.id)?.sourceRecovery?.customerName, "Same Shop");
    assert.equal(freeHistory.usageEvents.find((x) => x.quantity === 3)?.sourceRecovery, null);
    assert.deepEqual((await service.read(principal, { ...query, view: "past" })).usageEvents, []);

    const currentStart = new Date("2026-10-01T00:00:00.000Z");
    const currentEnd = new Date("2026-10-31T00:00:00.000Z");
    const currentPeriod = await db.billingPeriod.create({ data: {
      shopId: shop.id, subscriptionId: sub.id, planId: paidPlan.id,
      planKindSnapshot: "PAID_METERED", periodStart: currentStart, periodEnd: currentEnd, status: "OPEN",
    } });
    await db.subscription.update({ where: { id: sub.id }, data: {
      planId: paidPlan.id, billingPeriodId: currentPeriod.id,
      currentPeriodStart: currentStart, currentPeriodEnd: currentEnd,
    } });
    const paidDebit = await db.usageEvent.create({ data: event(shop.id, "2", {
      billingPeriodId: currentPeriod.id, sourceType: "PAID_RECOVERY_CONVERSATION",
      sourceId: ownedRecovery.id, occurredAt: new Date("2026-10-02T08:00:00.000Z"),
    }) });
    await db.usageEvent.create({ data: event(shop.id, "-1", {
      billingPeriodId: currentPeriod.id, correctionOfUsageEventId: paidDebit.id,
      sourceType: "PAID_CORRECTION", occurredAt: new Date("2026-10-03T08:00:00.000Z"),
    }) });
    await db.usageEvent.create({ data: event(shop.id, "2", {
      sourceType: "PURCHASED_RECOVERY_CREDITS", occurredAt: new Date("2026-10-15T08:00:00.000Z"),
    }) });
    await db.usageEvent.create({ data: event(shop.id, "1", {
      sourceType: "PROMOTIONAL_RECOVERY_CREDITS", occurredAt: new Date("2026-10-22T08:00:00.000Z"),
    }) });
    await db.usageEvent.create({ data: event(shop.id, "99", {
      sourceType: "PURCHASED_RECOVERY_CREDITS", occurredAt: currentEnd,
    }) });
    await db.usageEvent.create({ data: {
      ...event(shop.id, "200", { billingPeriodId: currentPeriod.id }), provider: "SHOPIFY",
    } });
    const paid = await service.read(principal, query);
    assert.equal(paid.state, "ready");
    assert.equal(paid.usagePagination.billId, currentPeriod.id);
    assert.equal(paid.usagePagination.totalQuantity, 4);
    assert.equal(paid.usagePagination.total, 4);
    assert.ok(paid.usageEvents.every((row, i) => i === 0 ||
      row.occurredAt <= paid.usageEvents[i - 1]!.occurredAt));
    assert.equal((await service.read(principal, { ...query, pageSize: 25, page: 2 })).usageEvents.length, 0);

    const pastPeriods = [];
    // Historical 30-day entitlements do not overlap. Using one-day offsets here
    // incorrectly associates September Free-plan credits with a historical paid period.
    for (let n = 1; n <= 28; n++) {
      const periodStart = new Date(Date.UTC(2026, 7, 1 - (n - 1) * 30));
      const periodEnd = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
      pastPeriods.push(await db.billingPeriod.create({ data: {
        shopId: shop.id, subscriptionId: sub.id, planId: paidPlan.id,
        planKindSnapshot: "PAID_METERED", periodStart, periodEnd, status: "CLOSED",
      } }));
    }
    const historical = pastPeriods[5]!;
    const historicalDebit = await db.usageEvent.create({ data: event(shop.id, "3", {
      billingPeriodId: historical.id, sourceType: "PAID_RECOVERY_CONVERSATION",
      occurredAt: new Date(historical.periodStart.getTime() + 86400000),
    }) });
    await db.usageEvent.create({ data: event(shop.id, "-2", {
      correctionOfUsageEventId: historicalDebit.id, sourceType: "PAID_CORRECTION",
      occurredAt: new Date("2026-10-05T10:00:00.000Z"),
    }) });
    const pastHistory = await service.read(principal, { ...query, view: "past", periodId: historical.id });
    assert.equal(pastHistory.usagePagination.total, 2);
    assert.equal(pastHistory.usagePagination.totalQuantity, 1);
    assert.deepEqual(pastHistory.usageEvents.map((row) => row.quantity), [-2, 3]);
    assert.equal(pastHistory.usagePagination.billId, historical.id);
    const past = await service.read(principal, { ...query, view: "past" });
    assert.equal(past.periodPage.items.length, 25);
    assert.ok(past.periodPage.nextCursor);
    const past2 = await service.read(principal, { ...query, view: "past", periodCursor: past.periodPage.nextCursor });
    assert.equal(past2.periodPage.items.length, 3);
    assert.ok(past2.periodPage.previousCursor);
    const backwards = await service.read(principal, { ...query, view: "past", periodCursor: past2.periodPage.previousCursor });
    assert.deepEqual(backwards.periodPage.items, past.periodPage.items);
    await assert.rejects(service.read(principal, { ...query, view: "past", periodId: currentPeriod.id }), UsageHistoryRequestError);
    await assert.rejects(service.read(principal, { ...query, view: "past", periodId: "other_shop_period" }), UsageHistoryRequestError);
    await assert.rejects(service.read(principal, { ...query, view: "past", periodCursor: `${past.periodPage.nextCursor!.slice(0, -3)}abc` }), UsageHistoryRequestError);
    const anotherInstallation = await db.wooCommerceInstallation.update({
      where: { id: installation.id }, data: { credentialDigest: Buffer.alloc(32, 43), credentialVersion: { increment: 1 } },
    });
    const rotatedPrincipal = { ...principal, credentialVersion: anotherInstallation.credentialVersion };
    await assert.rejects(service.read(rotatedPrincipal, { ...query, view: "past", periodCursor: past.periodPage.nextCursor }), UsageHistoryRequestError);
    await assert.rejects(service.read(principal, query), UsageHistoryIntegrityError);

    await db.subscription.update({ where: { id: sub.id }, data: {
      billingPeriodId: null, planId: freePlan.id, currentPeriodStart: null, currentPeriodEnd: null,
    } });
    assert.equal((await service.read(rotatedPrincipal, { ...query, view: "past", periodId: pastPeriods[0]!.id })).usageView, "past");
    assert.equal((await service.read(rotatedPrincipal, query)).usagePagination.totalQuantity, 106);
  } finally {
    await db.usageEvent.deleteMany({ where: { shopId: { in: shops } } });
    await db.billingPeriod.deleteMany({ where: { shopId: { in: shops } } });
    await db.subscription.deleteMany({ where: { shopId: { in: shops } } });
    await db.shop.deleteMany({ where: { id: { in: shops } } });
    await db.billingPlan.deleteMany({ where: { id: { in: plans } } });
    await db.$disconnect();
  }
});


test("API-022 PostgreSQL: cancellation preserves closed paid usage and signed late corrections", {
  skip: !url,
}, async () => {
  if (!url) return;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const suffix = randomUUID().replaceAll("-", "");
  let shopId: string | null = null;
  let planId: string | null = null;
  let observedAt = new Date("2026-10-20T12:00:00.000Z");
  const service = new MerchantUsageHistoryService(db, () => observedAt);
  const start = new Date("2026-10-01T00:00:00.000Z");
  const end = new Date("2026-10-31T00:00:00.000Z");
  try {
    const plan = await db.billingPlan.create({ data: {
      name: `Cancellation paid ${suffix}`, shopifyPlanHandle: `cancel-paid-${suffix}`, kind: "PAID_METERED",
    } });
    planId = plan.id;
    const shop = await db.shop.create({ data: {
      domain: `https://cancel-${suffix}.test.invalid`, platform: "WOOCOMMERCE", onboardingCompleted: true,
    } });
    shopId = shop.id;
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId, canonicalSiteUrl: shop.domain, credentialDigest: Buffer.alloc(32, 84),
    } });
    const principal = { shopId, canonicalSiteUrl: shop.domain,
      installationId: installation.id, credentialVersion: installation.credentialVersion };
    const subscription = await db.subscription.create({ data: {
      shopId, status: "ACTIVE", planId, cancelAtPeriodEnd: true,
      lastProviderLifecycleState: "CANCELLATION_SCHEDULED",
    } });
    const period = await db.billingPeriod.create({ data: {
      shopId, subscriptionId: subscription.id, planId, planKindSnapshot: "PAID_METERED",
      periodStart: start, periodEnd: end, status: "OPEN",
    } });
    await db.subscription.update({ where: { id: subscription.id }, data: {
      billingPeriodId: period.id, currentPeriodStart: start, currentPeriodEnd: end,
    } });
    let sequence = 0;
    const writeEvent = (quantity: string, extra: Record<string, unknown>) =>
      db.usageEvent.create({ data: {
        shopId: shop.id, metric: "RECOVERY_CONVERSATION", provider: "WOOCOMMERCE",
        quantity: new Prisma.Decimal(quantity),
        idempotencyKey: `arch035-cancel-${suffix}-${++sequence}`, ...extra,
      } });
    const debit = await writeEvent("3", {
      billingPeriodId: period.id, sourceType: "PAID_RECOVERY_CONVERSATION",
      occurredAt: new Date("2026-10-05T12:00:00.000Z"),
    });
    await writeEvent("2", {
      sourceType: "PURCHASED_RECOVERY_CREDITS", occurredAt: new Date("2026-10-10T12:00:00.000Z"),
    });
    await writeEvent("80", {
      sourceType: "FREE_RECOVERY_RESERVATION", occurredAt: new Date("2026-09-10T12:00:00.000Z"),
    });

    // Cancellation is scheduled, not effective: the paid entitlement remains current.
    const scheduled = await service.read(principal, query);
    assert.equal(scheduled.state, "ready");
    assert.equal(scheduled.usagePagination.billId, period.id);
    assert.equal(scheduled.usagePagination.total, 2);
    assert.equal(scheduled.usagePagination.totalQuantity, 5);

    await db.billingPeriod.update({ where: { id: period.id }, data: {
      status: "CLOSED", closedAt: end, closeReason: "CONTRACT_ENDED",
    } });
    await db.subscription.update({ where: { id: subscription.id }, data: {
      status: "NO_CONTRACT", planId: null, billingPeriodId: null,
      currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      lastProviderLifecycleState: "CANCELED", providerCoverageEndAt: end,
    } });
    await writeEvent("-1", {
      correctionOfUsageEventId: debit.id, sourceType: "PAID_CORRECTION",
      occurredAt: new Date("2026-11-02T12:00:00.000Z"),
    });
    observedAt = new Date("2026-11-03T12:00:00.000Z");

    const current = await service.read(principal, query);
    assert.equal(current.state, "unavailable");
    assert.deepEqual(current.usageEvents, []);
    assert.equal(current.usagePagination.billId, null);

    const history = await service.read(principal, { ...query, view: "past", periodId: period.id });
    assert.equal(history.state, "ready");
    assert.deepEqual(history.periodPage.items.map(({ id }) => id), [period.id]);
    assert.equal(history.usagePagination.billId, period.id);
    assert.equal(history.usagePagination.periodStart, start.toISOString());
    assert.equal(history.usagePagination.periodEnd, end.toISOString());
    assert.equal(history.usagePagination.total, 3);
    assert.equal(history.usagePagination.totalQuantity, 4);
    assert.deepEqual(history.usageEvents.map(({ quantity }) => quantity), [-1, 2, 3]);
    assert.equal((await service.read(principal, { ...query, view: "past" })).usagePagination.totalQuantity, 4);
  } finally {
    if (shopId) {
      await db.usageEvent.deleteMany({ where: { shopId } });
      await db.billingPeriod.deleteMany({ where: { shopId } });
      await db.subscription.deleteMany({ where: { shopId } });
      await db.shop.deleteMany({ where: { id: shopId } });
    }
    if (planId) await db.billingPlan.deleteMany({ where: { id: planId } });
    await db.$disconnect();
  }
});
