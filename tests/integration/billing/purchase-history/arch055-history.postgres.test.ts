import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { WooPurchaseHistoryReadService } from "../../../../src/billing/purchase-history/service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
type QueryLoggingClient = PrismaClient & {
  $on(event: "query", callback: (event: Prisma.QueryEvent) => void): void;
};
let prisma: QueryLoggingClient | undefined;

function database(): QueryLoggingClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  return prisma ??= new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [{ level: "query", emit: "event" }],
  }) as QueryLoggingClient;
}

after(async () => {
  if (!prisma) return;
  await prisma.shop.deleteMany({ where: { domain: `https://purchase-query-${suffix}.invalid` } });
  await prisma.billingPlan.deleteMany({ where: { shopifyPlanHandle: `purchase-query-${suffix}` } });
  await prisma.$disconnect();
});

test("PostgreSQL purchase history skips its page query when the same snapshot count is zero", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const statements: string[] = [];
  db.$on("query", (event) => statements.push(event.query));
  const plan = await db.billingPlan.create({
    data: { shopifyPlanHandle: `purchase-query-${suffix}`, name: "Query shape", kind: "FREE" },
  });
  const shop = await db.shop.create({
    data: { domain: `https://purchase-query-${suffix}.invalid`, platform: "WOOCOMMERCE", onboardingCompleted: true },
  });
  const principal: WooInstallationPrincipal = {
    installationId: `purchase-query-install-${suffix}`,
    shopId: shop.id,
    canonicalSiteUrl: shop.domain,
    credentialVersion: 1,
  };
  const start = statements.length;

  const result = await new WooPurchaseHistoryReadService(db).read(principal, {
    filter: "ALL", page: 1, pageSize: 20,
  });

  assert.equal(result.total, 0);
  assert.deepEqual(result.purchases, []);
  const purchaseSelects = statements.slice(start).filter((sql) =>
    /SELECT/i.test(sql) && /"billing"\."RecoveryCreditPurchase"/i.test(sql));
  assert.equal(purchaseSelects.length, 1, purchaseSelects.join("\n"));
  assert.match(purchaseSelects[0]!, /COUNT\s*\(/i);
  assert.ok(plan.id);
});
