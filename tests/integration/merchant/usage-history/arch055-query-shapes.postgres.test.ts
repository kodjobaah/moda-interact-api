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
