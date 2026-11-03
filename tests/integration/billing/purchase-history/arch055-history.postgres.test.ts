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
  await prisma.shop.deleteMany({ where: { domain: { in: [
    `https://purchase-query-${suffix}.invalid`,
    `https://purchase-query-five-${suffix}.invalid`,
  ] } } });
  await prisma.billingPlan.deleteMany({ where: { shopifyPlanHandle: { in: [
    `purchase-query-${suffix}`,
    `purchase-query-five-${suffix}`,
  ] } } });
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

test("PostgreSQL purchase history retains its page query for five matching purchases", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const statements: string[] = [];
  db.$on("query", (event) => statements.push(event.query));
  const plan = await db.billingPlan.create({
    data: { shopifyPlanHandle: `purchase-query-five-${suffix}`, name: "Query shape", kind: "FREE" },
  });
  const shop = await db.shop.create({
    data: {
      domain: `https://purchase-query-five-${suffix}.invalid`,
      platform: "WOOCOMMERCE",
      onboardingCompleted: true,
    },
  });
  const createdAt = new Date("2026-11-02T12:00:00.000Z");
  await db.recoveryCreditPurchase.createMany({
    data: Array.from({ length: 5 }, (_, index) => ({
      id: `purchase-query-five-${suffix}-${index}`,
      shopId: shop.id,
      planId: plan.id,
      creditsGranted: 10,
      provider: "WOOCOMMERCE",
      createdAt: new Date(createdAt.getTime() + index),
    })),
  });
  const principal: WooInstallationPrincipal = {
    installationId: `purchase-query-five-install-${suffix}`,
    shopId: shop.id,
    canonicalSiteUrl: shop.domain,
    credentialVersion: 1,
  };
  const start = statements.length;

  const result = await new WooPurchaseHistoryReadService(db).read(principal, {
    filter: "ALL", page: 1, pageSize: 5,
  });

  assert.equal(result.total, 5);
  assert.equal(result.totalPages, 1);
  assert.equal(result.purchases.length, 5);
  const purchaseSelects = statements.slice(start).filter((sql) =>
    /SELECT/i.test(sql) && /"billing"\."RecoveryCreditPurchase"/i.test(sql));
  assert.equal(purchaseSelects.length, 2, purchaseSelects.join("\n"));
  assert.match(purchaseSelects[0]!, /COUNT\s*\(/i);
  assert.doesNotMatch(purchaseSelects[1]!, /COUNT\s*\(/i);
});

// Opt-in task-local comparisons. The runner copies this exact instrumentation
// into the pinned baseline archive and supplies equivalent migrated databases.
type CommercialCall = { port: string; returnedRows: number | null; affectedRows: number | null; nestedRows: Record<string, number> };
type CommercialStats = { calls: CommercialCall[]; transactions: { ms: number; outcome: string }[]; attempts: number };
type CommercialFixture = { shopId: string; principal: WooInstallationPrincipal; planId: string };
const commercialVersion = process.env.ARCH055_COMMERCIAL_VERSION;
const commercialNow = new Date("2026-11-02T12:00:00.000Z");

function commercialDatabase(db: PrismaClient, stats: CommercialStats): PrismaClient {
  const observe = (target: object, prefix: string): object => new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(value, object, args);
        const method = String(property);
        const count = result && typeof result === "object" && "count" in result ? Number(result.count) : null;
        const nestedRows: Record<string, number> = {};
        const countRelations = (row: unknown): void => {
          if (!row || typeof row !== "object" || row instanceof Date || row instanceof Prisma.Decimal || row instanceof Uint8Array) return;
          if (Array.isArray(row)) { row.forEach(countRelations); return; }
          for (const [key, item] of Object.entries(row)) {
            if (Array.isArray(item)) nestedRows[key] = (nestedRows[key] ?? 0) + item.length;
            countRelations(item);
          }
        };
        countRelations(result);
        stats.calls.push({
          nestedRows, port: `${prefix}.${method}`,
          returnedRows: Array.isArray(result) ? result.length : result === null ? 0 : typeof result === "object" ? 1 : null,
          affectedRows: /^(?:create|update|delete|upsert)/.test(method)
            ? count ?? (result === null ? 0 : 1) : method === "$executeRaw" ? Number(result) : null,
        });
        return result;
      };
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property !== "$transaction") return Reflect.get(target, property);
      return async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: Parameters<PrismaClient["$transaction"]>[1]) => {
        const start = performance.now();
        try {
          const result = await db.$transaction(async tx => {
            stats.attempts++;
            return callback(new Proxy(tx, {
              get(transaction, key) {
                const value: unknown = Reflect.get(transaction, key);
                if (typeof value === "function") return Reflect.get(observe(transaction, "tx"), key);
                if (value && typeof value === "object") return observe(value, String(key));
                return value;
              },
            }));
          }, options);
          stats.transactions.push({ ms: performance.now() - start, outcome: "commit" });
          return result;
        } catch (error) {
          stats.transactions.push({ ms: performance.now() - start, outcome: "rollback" });
          throw error;
        }
      };
    },
  });
}

async function commercialFixture(db: PrismaClient, id: string, paid = false): Promise<CommercialFixture> {
  const shopId = `commercial_${id}`;
  const domain = `https://${id.replaceAll("_", "-")}.commercial.invalid`;
  await db.shop.create({ data: { id: shopId, domain, platform: "WOOCOMMERCE", onboardingCompleted: true,
    defaultLanguageTag: "en", createdAt: commercialNow, updatedAt: commercialNow } });
  const installation = await db.wooCommerceInstallation.create({ data: {
    id: `${shopId}_installation`, shopId, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32, 55),
  } });
  const plan = await db.billingPlan.create({ data: {
    id: `${shopId}_plan`, shopifyPlanHandle: `${shopId}_handle`, name: "Commercial profile",
    kind: paid ? "PAID_METERED" : "FREE",
  } });
  await db.subscription.create({ data: { id: `${shopId}_subscription`, shopId, status: "ACTIVE",
    planId: plan.id, createdAt: commercialNow, updatedAt: commercialNow } });
  return { shopId, planId: plan.id, principal: { shopId, installationId: installation.id,
    canonicalSiteUrl: domain, credentialVersion: 1 } };
}

async function commercialSnapshot(db: PrismaClient, shopId: string) {
  return {
    shop: await db.shop.findUnique({ where: { id: shopId } }),
    subscription: await db.subscription.findUnique({ where: { shopId } }),
    settings: await db.shopSettings.findUnique({ where: { shopId } }),
    coupons: await db.shopifyDiscount.findMany({ where: { shopId }, orderBy: { id: "asc" } }),
    grants: await db.promotionalCreditGrant.findMany({ where: { shopId }, orderBy: { id: "asc" } }),
    selection: await db.merchantPromotionSelection.findUnique({ where: { shopId } }),
    purchases: await db.recoveryCreditPurchase.findMany({ where: { shopId }, orderBy: { id: "asc" } }),
    usage: await db.usageEvent.aggregate({ where: { shopId }, _count: { _all: true }, _sum: { quantity: true } }),
  };
}

function commercialSummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) };
}

test("ARCH-055 commercial paired M11-M14 profiles", {
  skip: !databaseUrl || !["baseline", "candidate"].includes(commercialVersion ?? ""),
}, async () => {
  if (!databaseUrl || !commercialVersion) return;
  const [{ MerchantPromotionsService }, { MerchantDiscountOffersService }, { MerchantUsageHistoryService },
    { BillingPresentationReadService }, { BillingPlanCatalogueReadService }, { createLogger },
    { publishedPricingTranslations }] = await Promise.all([
    import("../../../../src/merchant/promotions/service.js"),
    import("../../../../src/merchant/discount-offers/service.js"),
    import("../../../../src/merchant/usage-history/history.service.js"),
    import("../../../../src/billing/presentation/billing-read.service.js"),
    import("../../../../src/billing/presentation/plan-catalogue-read.service.js"),
    import("@modainteract/moda-interact-shared/logging"),
    import("../../../helpers/merchant-pricing-test-fixtures.js"),
  ]);
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [{ level: "query", emit: "event" }] });
  const sql: string[] = [];
  let capturing = false;
  db.$on("query", event => { if (capturing) sql.push(event.query.replace(/\s+/g, " ").trim()); });
  const logger = createLogger({ serviceName: "commercial-test", environment: "test", sink: () => {} });
  const profiles = [
    "M11-promo-0-0", "M11-promo-0-7", "M11-promo-7-0", "M11-promo-7-7",
    "M11-purchase-0", "M11-purchase-5",
    "M12-mode", "M12-replace", "M12-noop", "M12-first",
    ...["current", "default", "rank2", "rank30"].flatMap(view => [`M13-${view}-v1`, `M13-${view}-v2`]),
    "M14-billing-match", "M14-billing-mismatch", "M14-catalogue-fr-CA", "M14-catalogue-unavailable",
    "M14-settings-CURRENT", "M14-settings-ERROR",
    "E-batch-clean-fixed", "E-batch-clean-small", "E-batch-invalid-fixed", "E-batch-invalid-small",
    "E-promotion-select",
  ];
  try {
    // READY catalogue rows require the canonical complete locale set. Seed it
    // identically for both versions; the requested/default candidates are fr-CA,
    // fr and en. Noncandidate translations make returned-row narrowing visible.
    for (let index = 0; index < 4; index++) {
      await db.merchantPricingPlan.create({ data: {
        id: `commercial_catalogue_${index}`, shopifyPlanHandle: `commercial_catalogue_handle_${index}`,
        displayName: `Plan ${index}`, planKind: index === 0 ? "FREE" : "PAID_METERED",
        cataloguePosition: index, includedRecoveryCredits: index === 0 ? 2 : 10,
        allowancePeriod: index === 0 ? "LIFETIME" : "EVERY_30_DAYS", billingPeriod: "EVERY_30_DAYS",
        recurringAmountMinor: index === 0 ? 0 : 1000, currency: "USD",
        translations: { create: publishedPricingTranslations(`Description ${index}`) },
        highlights: { create: [0, 1].map(position => ({
          contentKey: `00000000-0000-4000-8000-${String(index * 2 + position + 1).padStart(12, "0")}`,
          position, translations: { create: publishedPricingTranslations("Highlight").map(row => ({
            locale: row.locale, merchantTitle: "Title", merchantDescription: row.merchantDescription,
          })) },
        })) },
      } });
    }
    const admin = await db.platformAdmin.create({ data: { id: "commercial_admin", email: "commercial@test.invalid" } });
    for (const profile of profiles) {
      const times: number[] = [], transactionTimes: number[] = [];
      for (let trial = 0; trial < 7; trial++) {
        const fixture = await commercialFixture(db, `${profile.replaceAll("-", "_")}_${trial}`, profile.startsWith("M13"));
        const { shopId, principal, planId } = fixture;
        let invoke: (observed: PrismaClient) => Promise<unknown>;
        let verify: (result: unknown, stats: CommercialStats, statements: string[]) => void = () => {};
        let expectedError: string | null = null;
        let restoreCatalogue: (() => Promise<void>) | undefined;
        if (profile.startsWith("M11-promo") || profile === "E-promotion-select") {
          const [, , offerText, historyText] = profile.split("-");
          const offers = profile === "E-promotion-select" ? 1 : Number(offerText);
          const history = profile === "E-promotion-select" ? 0 : Number(historyText);
          for (let index = 0; index < offers + history; index++) {
            const campaign = await db.promotionCampaign.create({ data: {
              id: `${shopId}_campaign_${index}`, name: "Profile", merchantDescription: "Profile",
              scope: "SHOP", targetShopId: shopId, quantity: 9, status: index < offers ? "ACTIVE" : "CLOSED",
              startsAt: new Date("2026-10-01T00:00:00Z"), expiresAt: new Date("2026-12-01T00:00:00Z"),
              createdByPlatformAdminId: admin.id,
            } });
            if (index >= offers) await db.promotionalCreditGrant.create({ data: {
              id: `${shopId}_grant_${index}`, shopId, campaignId: campaign.id, quantity: 9,
              firstSelectedAt: commercialNow, lastSelectedAt: commercialNow,
            } });
          }
          invoke = observed => new MerchantPromotionsService(observed, () => commercialNow).read(principal,
            { offerPage: 1, historyPage: 1, locale: "en" });
          verify = (value, stats) => {
            const result = value as Awaited<ReturnType<InstanceType<typeof MerchantPromotionsService>["read"]>>;
            assert.equal(result.offersPagination.totalEntries, offers);
            assert.equal(result.history.totalEntries, history);
            assert.equal(result.offers.length, Math.min(offers, 6));
            assert.equal(result.history.entries.length, Math.min(history, 6));
            assert.equal(result.selection, null);
            assert.equal(stats.calls.filter(call => call.port === "promotionCampaign.findMany").length,
              commercialVersion === "candidate" && offers === 0 ? 0 : 1);
            assert.equal(stats.calls.filter(call => call.port === "promotionalCreditGrant.findMany").length,
              commercialVersion === "candidate" && history === 0 ? 0 : 1);
          };
          if (profile === "E-promotion-select") {
            const initial = await new MerchantPromotionsService(db, () => commercialNow).read(principal,
              { offerPage: 1, historyPage: 1, locale: "en" });
            invoke = observed => new MerchantPromotionsService(observed, () => commercialNow).select(principal,
              { campaignId: `${shopId}_campaign_0`, expectedRevision: initial.revision });
            verify = value => {
              const result = value as Awaited<ReturnType<InstanceType<typeof MerchantPromotionsService>["select"]>>;
              assert.equal(result.selection.campaignId, `${shopId}_campaign_0`);
            };
          }
        } else if (profile.startsWith("M11-purchase")) {
          const count = Number(profile.split("-").at(-1));
          if (count) await db.recoveryCreditPurchase.createMany({ data: Array.from({ length: count }, (_, index) => ({
            id: `${shopId}_purchase_${index}`, shopId, planId, creditsGranted: 10, provider: "WOOCOMMERCE",
            createdAt: new Date(commercialNow.getTime() + index),
          })) });
          invoke = observed => new WooPurchaseHistoryReadService(observed).read(principal, { filter: "ALL", page: 1, pageSize: 5 });
          verify = (value, stats) => {
            const result = value as Awaited<ReturnType<WooPurchaseHistoryReadService["read"]>>;
            assert.equal(result.total, count);
            assert.equal(result.purchases.length, count);
            assert.equal(stats.calls.filter(call => call.port === "recoveryCreditPurchase.findMany").length,
              commercialVersion === "candidate" && count === 0 ? 0 : 1);
          };
        } else if (profile.startsWith("M12") || profile.startsWith("M14-settings") || profile.startsWith("E-batch")) {
          const first = profile === "M12-first";
          const ids = Array.from({ length: profile.startsWith("E-batch") ? 250 : 51 }, (_, index) => `${shopId}_coupon_${String(index).padStart(3, "0")}`);
          await db.shopifyDiscountCatalogue.create({ data: { shopId,
            status: profile.endsWith("ERROR") ? "ERROR" : "CURRENT", syncGeneration: 1, lastSuccessfulSyncAt: commercialNow } });
          await db.shopifyDiscount.createMany({ data: ids.map((id, index) => ({
            id, shopId, shopifyDiscountNodeId: `woo:coupon:${index}`, providerType: "WooCoupon:percent",
            method: "CODE", providerStatus: "ACTIVE", fixedSelectable: true, codeCount: 1, title: `CODE${index}`,
            singleRedeemCode: profile.startsWith("E-batch-invalid") && index < 11 ? "\nUNSAFE" : `CODE${index}`, providerSnapshot: {}, isAvailable: !first && index < 50,
            lastSeenSyncGeneration: 1, lastSyncedAt: commercialNow, updatedAt: commercialNow,
          })) });
          if (!first) await db.shopSettings.create({ data: { shopId, recoveryOfferMode: "NONE", updatedAt: commercialNow } });
          const selected = profile === "M12-replace" ? ids.slice(1) : ids.slice(0, 50);
          const mode = profile === "M12-mode" ? "AI_BEST_APPLICABLE" as const : "NONE" as const;
          invoke = observed => profile.startsWith("M14")
            ? new MerchantDiscountOffersService(observed, () => commercialNow).read(principal)
            : new MerchantDiscountOffersService(observed, () => commercialNow).save(principal,
              { recoveryOfferMode: mode, selectedDiscountIds: selected });
          verify = (value, stats) => {
            const result = value as Awaited<ReturnType<InstanceType<typeof MerchantDiscountOffersService>["read"]>>;
            assert.deepEqual(result.merchant.selectedDiscountIds, selected);
            assert.equal(result.merchant.recoveryOfferMode, mode);
            const assignments = stats.calls.filter(call => call.port === "shopifyDiscount.updateMany")
              .reduce((total, call) => total + (call.affectedRows ?? 0), 0);
            assert.equal(assignments, profile.startsWith("M14") || profile === "M12-noop" ? 0
              : first ? 50 : commercialVersion === "baseline" ? 100 : profile === "M12-replace" ? 2 : 0);
          };
          if (profile.startsWith("E-batch")) {
            const reference = await new MerchantDiscountOffersService(db, () => commercialNow)
              .catalogue(principal, { limit: 10 });
            // Isolated batch-loop experiment, not an alternative production
            // service. Authorization/reference projection run outside timing.
            // Both variants use the requested batch size for end-of-data.
            invoke = observed => observed.$transaction(async tx => {
              const visible: Array<{ id: string; code: string }> = [];
              let cursor: string | undefined;
              let firstBatch = true;
              while (visible.length <= 10) {
                const take = firstBatch && profile.endsWith("small") ? 11 : 100;
                firstBatch = false;
                const rows = await tx.shopifyDiscount.findMany({
                  where: { shopId, shopifyDiscountNodeId: { startsWith: "woo:coupon:" },
                    providerType: { startsWith: "WooCoupon:" }, method: "CODE", lastSeenSyncGeneration: 1,
                    unavailableAt: null, providerStatus: { notIn: ["REMOVED", "UNDELIVERABLE"] },
                    singleRedeemCode: { not: null }, ...(cursor ? { id: { gt: cursor } } : {}) },
                  orderBy: { id: "asc" }, take,
                  select: { id: true, title: true, summary: true, providerType: true,
                    singleRedeemCode: true, startsAt: true, endsAt: true, isAvailable: true },
                });
                for (const row of rows) {
                  if (row.singleRedeemCode?.trim() && ![...row.singleRedeemCode].some(character => {
                    const point = character.codePointAt(0) ?? 0xffff;
                    return point <= 0x1f || point === 0x7f;
                  })) {
                    visible.push({ id: row.id, code: row.singleRedeemCode });
                  }
                  if (visible.length > 10) break;
                }
                if (visible.length > 10 || rows.length < take) break;
                cursor = rows.at(-1)?.id;
              }
              return { items: visible.slice(0, 10), hasMore: visible.length > 10,
                nextCursor: visible.length > 10 ? visible[9]!.id : null };
            }, { isolationLevel: "RepeatableRead" });
            verify = value => {
              const result = value as { items: Array<{ id: string; code: string }>; hasMore: boolean; nextCursor: string | null };
              assert.deepEqual(result.items, reference.items.map(item => ({ id: item.id, code: item.code })));
              assert.equal(result.hasMore, reference.hasMore);
              assert.equal(result.nextCursor, reference.nextCursor);
            };
          }
        } else if (profile.startsWith("M13")) {
          const subscriptionId = `${shopId}_subscription`;
          const start = new Date("2026-11-01T00:00:00Z");
          const periods: Array<{ id: string; periodStart: Date; periodEnd: Date }> = [];
          for (let rank = 0; rank <= 30; rank++) {
            const periodStart = new Date(start.getTime() - rank * 30 * 86400000);
            const period = await db.billingPeriod.create({ data: {
              id: `${shopId}_period_${rank}`, shopId, subscriptionId, planId, planKindSnapshot: "PAID_METERED",
              periodStart, periodEnd: new Date(periodStart.getTime() + 30 * 86400000), status: rank ? "CLOSED" : "OPEN",
            } });
            periods.push(period);
            const base = Array.from({ length: 29 }, (_, index) => ({
              id: `${period.id}_event_${index}`, shopId, metric: "RECOVERY_CONVERSATION" as const,
              quantity: new Prisma.Decimal(2), provider: "WOOCOMMERCE", sourceType: "PURCHASED_RECOVERY_CREDITS",
              billingPeriodId: period.id, occurredAt: new Date(periodStart.getTime() + index * 1000),
              idempotencyKey: `${period.id}_event_${index}`,
            }));
            await db.usageEvent.createMany({ data: [...base, ...[0, 1].map(index => ({
              ...base[index]!, id: `${period.id}_correction_${index}`, quantity: new Prisma.Decimal(-1),
              sourceType: "PAID_CORRECTION", correctionOfUsageEventId: base[index]!.id,
              occurredAt: new Date((rank === 0 ? periodStart.getTime() + 30_000 : period.periodEnd.getTime()) + index * 1000),
              idempotencyKey: `${period.id}_correction_${index}`,
            }))] });
          }
          await db.subscription.update({ where: { id: subscriptionId }, data: { billingPeriodId: periods[0]!.id,
            currentPeriodStart: periods[0]!.periodStart, currentPeriodEnd: periods[0]!.periodEnd } });
          const variant = profile.split("-")[1];
          const version = profile.endsWith("v2") ? 2 : 1;
          const periodId = variant === "rank2" ? periods[2]!.id : variant === "rank30" ? periods[30]!.id : null;
          invoke = observed => new MerchantUsageHistoryService(observed, () => commercialNow).read(principal,
            { view: variant === "current" ? "current" : "past", periodId, kind: "RECOVERY_CONVERSATION",
              page: 1, pageSize: 50, periodCursor: null, responseVersion: version });
          verify = (value, stats, statements) => {
            const result = value as Awaited<ReturnType<InstanceType<typeof MerchantUsageHistoryService>["read"]>>;
            assert.equal(stats.calls.filter(call => call.port === "usageEvent.count").length,
              commercialVersion === "baseline" ? 1 : 0);
            assert.equal(stats.calls.filter(call => call.port === "usageEvent.aggregate").length, 1);
            assert.equal(stats.calls.filter(call => call.port === "billingPeriod.findFirst").length,
              commercialVersion === "baseline" ? variant === "current" ? 1 : 2 : variant === "current" || variant === "rank30" ? 1 : 0);
            assert.equal(statements.filter(statement => /COUNT\s*\(/i.test(statement) && /SUM\s*\(/i.test(statement)).length,
              commercialVersion === "candidate" ? 1 : 0);
            assert.equal(result.schemaVersion, version);
            assert.equal(result.usagePagination.total, 31);
            assert.equal(result.usagePagination.totalQuantity, 56);
            assert.equal(result.usageEvents.length, 31);
            assert.equal(result.periodPage.items.length, variant === "current" ? 1 : 25);
            assert.equal(result.usagePagination.billId, periodId ?? periods[variant === "current" ? 0 : 1]!.id);
            if (result.schemaVersion === 2) assert.ok(result.usageEvents.every(event => event.chargedAgainst === "UNATTRIBUTED"));
          };
        } else if (profile.startsWith("M14-catalogue")) {
          if (profile.endsWith("unavailable")) {
            const translations = await db.merchantPricingPlanTranslation.findMany({
              where: { locale: { in: ["fr", "en"] } },
            });
            // SQL btrim accepts tab-only text while the public projection's
            // stricter trim rejects it. Keep canonical row-count constraints.
            await db.merchantPricingPlanTranslation.updateMany({
              where: { OR: [
                { merchantPricingPlanId: "commercial_catalogue_0", locale: "en" },
                { merchantPricingPlanId: "commercial_catalogue_1", locale: "fr" },
              ] }, data: { merchantDescription: "\t" },
            });
            restoreCatalogue = async () => {
              for (const row of translations) await db.merchantPricingPlanTranslation.update({
                where: { id: row.id }, data: { merchantDescription: row.merchantDescription },
              });
            };
            expectedError = "billing_catalogue_translation_unavailable";
          }
          invoke = observed => new BillingPlanCatalogueReadService(observed, logger).read(principal, "fr-CA");
          verify = value => {
            if (expectedError) return;
            const result = value as Awaited<ReturnType<InstanceType<typeof BillingPlanCatalogueReadService>["read"]>>;
            assert.equal(result.resolvedLocale, "fr");
            assert.equal(result.plans.length, 4);
            assert.ok(result.plans.every(plan => plan.highlights.length === 2));
          };
        } else {
          const pending = await db.billingPlan.create({ data: {
            id: `${shopId}_pending`, shopifyPlanHandle: "commercial_catalogue_handle_1", name: "Pending", kind: "PAID_METERED",
          } }).catch(async error => {
            // Handles are global identities; subsequent samples reuse this
            // immutable operational pending plan outside measurement windows.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
              return db.billingPlan.findUniqueOrThrow({ where: { shopifyPlanHandle: "commercial_catalogue_handle_1" } });
            }
            throw error;
          });
          await db.billingPlan.update({ where: { id: planId }, data: {
            shopifyPlanHandle: `${shopId}_unmapped`,
          } });
          // A separate current Free operational plan shares the catalogue handle.
          const current = await db.billingPlan.upsert({ where: { shopifyPlanHandle: "commercial_catalogue_handle_0" },
            create: { shopifyPlanHandle: "commercial_catalogue_handle_0", name: "Free", kind: "FREE" }, update: {} });
          await db.subscription.update({ where: { shopId }, data: { planId: current.id, pendingPlanId: pending.id } });
          await db.shopEntitlementCounter.create({ data: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
            grantedQuantity: 2, committedQuantity: 0, reservedQuantity: 0 } });
          await db.billingOperation.create({ data: {
            id: `${shopId}_operation`, shopId, kind: "PLAN_SWITCH", state: "AWAITING_CONFIRMATION",
            requestKey: "profile", requestFingerprint: Buffer.alloc(32),
            merchantPricingPlanId: `commercial_catalogue_${profile.endsWith("mismatch") ? 2 : 1}`,
            quotedAmountMinor: 1000, quotedCurrency: "USD", quotedBillingPeriod: "EVERY_30_DAYS",
          } });
          expectedError = profile.endsWith("mismatch") ? "billing_operation_conflict" : null;
          invoke = observed => new BillingPresentationReadService(observed).read(principal, commercialNow);
          verify = value => {
            if (expectedError) return;
            const result = value as Awaited<ReturnType<InstanceType<typeof BillingPresentationReadService>["read"]>>;
            assert.equal(result.pendingPlan?.merchantPricingPlanId, "commercial_catalogue_1");
          };
        }
        const before = await commercialSnapshot(db, shopId);
        const stats: CommercialStats = { calls: [], transactions: [], attempts: 0 };
        sql.length = 0;
        const observed = commercialDatabase(db, stats);
        let result: unknown, errorCode: string | null = null;
        const started = performance.now();
        capturing = true;
        try { result = await invoke(observed); }
        catch (error) {
          if (!error || typeof error !== "object" || !("code" in error)) throw error;
          errorCode = String(error.code);
          if (errorCode !== expectedError) throw error;
        } finally { capturing = false; }
        const operationMs = performance.now() - started;
        const statements = [...sql];
        assert.equal(errorCode, expectedError);
        verify(result, stats, statements);
        const after = await commercialSnapshot(db, shopId);
        const readOnly = (!profile.startsWith("M12") || profile === "M12-noop") && profile !== "E-promotion-select";
        if (readOnly) {
          assert.deepEqual(after, before, "read/no-op must preserve durable state and timestamps");
          assert.ok(stats.calls.every(call => call.affectedRows === null || call.affectedRows === 0));
        }
        if (profile.startsWith("M12")) {
          assert.deepEqual(after.shop, before.shop);
          assert.deepEqual(after.subscription, before.subscription);
          assert.deepEqual(after.grants, before.grants);
          assert.deepEqual(after.usage, before.usage);
          assert.deepEqual(after.purchases, before.purchases);
        }
        const normalize = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
        const changedCouponRows = before.coupons.filter((row, index) => normalize(row) !== normalize(after.coupons[index])).length;
        const couponFlagsChanged = before.coupons.filter((row, index) => row.isAvailable !== after.coupons[index]?.isAvailable).length;
        const netTargetRowsChanged = changedCouponRows + Number(normalize(before.settings) !== normalize(after.settings)) +
          Math.max(0, after.grants.length - before.grants.length) +
          Number(normalize(before.selection) !== normalize(after.selection));
        const controls = { begin: 0, isolation: 0, commit: 0, rollback: 0 };
        for (const statement of statements) {
          if (/^BEGIN\b/i.test(statement)) controls.begin++;
          if (/\b(?:SET TRANSACTION|ISOLATION LEVEL)\b/i.test(statement)) controls.isolation++;
          if (/^COMMIT\b/i.test(statement)) controls.commit++;
          if (/^ROLLBACK\b/i.test(statement)) controls.rollback++;
        }
        const shapes = new Map<string, number>();
        for (const statement of statements) shapes.set(statement, (shapes.get(statement) ?? 0) + 1);
        assert.equal(stats.transactions.length, 1);
        const transactionMs = stats.transactions[0]!.ms;
        console.log(`ARCH055_COMMERCIAL_SAMPLE ${JSON.stringify({
          version: commercialVersion, profile, sample: trial < 2 ? `warmup-${trial}` : `recorded-${trial - 2}`,
          serviceCalls: profile.startsWith("E-batch") ? 0 : 1,
          measurementBoundary: profile.startsWith("E-batch") ? "isolated batch loop; authorization/reference outside timer" : "service method",
          logicalClientCalls: stats.calls.length + stats.transactions.length, clientResults: stats.calls,
          sqlStatementCount: statements.length, sqlShapes: [...shapes].map(([sql, count]) => ({ sql, count })),
          transactionControlStatements: controls, transactionOutcome: stats.transactions[0]!.outcome,
          operationMs, transactionMs, callbackRetries: Math.max(0, stats.attempts - 1), netTargetRowsChanged,
          changedCouponRows, couponFlagsChanged, externalInvocations: "not measured (selected services expose no external ports)",
          wireBytes: "not measured", triggerInternalWork: "not measured", errorCode,
        })}`);
        if (trial >= 2) { times.push(operationMs); transactionTimes.push(transactionMs); }
        await restoreCatalogue?.();
      }
      console.log(`ARCH055_COMMERCIAL_SUMMARY ${JSON.stringify({ version: commercialVersion, profile,
        recordedSamples: 5, operationMs: commercialSummary(times), transactionMs: commercialSummary(transactionTimes) })}`);
    }
    type PlanNode = { "Node Type": string; "Index Name"?: string; "Actual Rows": number;
      "Actual Loops": number; "Actual Total Time": number; "Shared Hit Blocks"?: number; Plans?: PlanNode[] };
    type Explained = Array<{ "QUERY PLAN": Array<{ Plan: PlanNode; "Planning Time": number; "Execution Time": number }> }>;
    const plans: Array<[string, Explained]> = [
      ["coupon", await db.$queryRaw<Explained>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT "id", "isAvailable" FROM "shopify"."ShopifyDiscount"
        WHERE "shopId" = ${"commercial_E_batch_clean_fixed_2"} AND "method" = 'CODE'
        ORDER BY "id" LIMIT 100
      `)],
      ["purchase-history", await db.$queryRaw<Explained>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT "id" FROM "billing"."RecoveryCreditPurchase"
        WHERE "shopId" = ${"commercial_M11_purchase_5_2"} AND "provider" = 'WOOCOMMERCE'
        ORDER BY "createdAt" DESC, "id" DESC LIMIT 5
      `)],
    ];
    for (const [profile, rows] of plans) {
      const explained = rows[0]!["QUERY PLAN"][0]!;
      const nodes: unknown[] = [];
      const flatten = (node: PlanNode): void => {
        nodes.push({ nodeType: node["Node Type"], indexName: node["Index Name"] ?? null,
          actualRows: node["Actual Rows"], loops: node["Actual Loops"], elapsedMs: node["Actual Total Time"],
          sharedHitBlocks: node["Shared Hit Blocks"] ?? null });
        node.Plans?.forEach(flatten);
      };
      flatten(explained.Plan);
      console.log(`ARCH055_COMMERCIAL_PLAN ${JSON.stringify({ version: commercialVersion, profile, nodes,
        planningMs: explained["Planning Time"], executionMs: explained["Execution Time"] })}`);
    }
  } finally { await db.$disconnect(); }
});

test("PostgreSQL history rejects refund overflow and pins concurrent refund evidence", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const db = database();
  const mutator = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const fixture = await commercialFixture(db, `refund_${suffix}`);
  const purchase = await db.recoveryCreditPurchase.create({ data: {
    id: `${fixture.shopId}_purchase`, shopId: fixture.shopId, planId: fixture.planId,
    provider: "WOOCOMMERCE", creditsGranted: 10, createdAt: commercialNow,
  } });
  const refundData = (index: number) => ({
    id: `${fixture.shopId}_refund_${index}`, shopId: fixture.shopId, purchaseId: purchase.id,
    source: "MERCHANT_UI" as const, status: "REJECTED" as const, provider: "WOOCOMMERCE",
    purchaseCreditsGrantedSnapshot: 10, currentAmountAtRequestSnapshot: 10,
    reservedAmountAtRequestSnapshot: 0, availableAmountAtRequestSnapshot: 10,
    purchaseProviderAmountSnapshot: new Prisma.Decimal(10), purchaseProviderCurrencySnapshot: "USD",
    requestKey: `${fixture.shopId}_refund_${index}`, createdAt: new Date(commercialNow.getTime() + index),
  });
  try {
    let signalRead: () => void = () => {};
    let releaseRead: () => void = () => {};
    const readReached = new Promise<void>(resolve => { signalRead = resolve; });
    const continueRead = new Promise<void>(resolve => { releaseRead = resolve; });
    const paused = new Proxy(db, {
      get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction(tx => callback(new Proxy(tx, {
            get(transaction, key) {
              if (key !== "shop") return Reflect.get(transaction, key);
              return { findUnique: async (args: Prisma.ShopFindUniqueArgs) => {
                const shop = await transaction.shop.findUnique(args);
                signalRead();
                await continueRead;
                return shop;
              } };
            },
          })), { isolationLevel: "RepeatableRead" });
      },
    });
    const request = new WooPurchaseHistoryReadService(paused).read(fixture.principal,
      { filter: "ALL", page: 1, pageSize: 5 });
    await readReached;
    try { await mutator.recoveryCreditRefund.create({ data: refundData(0) }); }
    finally { releaseRead(); }
    const pinned = await request;
    assert.equal(pinned.total, 1);
    assert.equal(pinned.purchases[0]!.latestRefund, null, "later committed refund is outside the first snapshot");
    const fresh = await new WooPurchaseHistoryReadService(db).read(fixture.principal,
      { filter: "ALL", page: 1, pageSize: 5 });
    assert.equal(fresh.purchases[0]!.latestRefund?.status, "REJECTED");
    await db.recoveryCreditRefund.createMany({ data: Array.from({ length: 10 }, (_, index) => refundData(index + 1)) });
    await assert.rejects(() => new WooPurchaseHistoryReadService(db).read(fixture.principal,
      { filter: "ALL", page: 1, pageSize: 5 }), error => error instanceof Error &&
      "code" in error && error.code === "billing_integrity_invalid");
    assert.equal(await db.recoveryCreditRefund.count({ where: { purchaseId: purchase.id } }), 11);
  } finally {
    await mutator.$disconnect();
    await db.recoveryCreditRefund.deleteMany({ where: { shopId: fixture.shopId } });
    await db.shop.delete({ where: { id: fixture.shopId } });
    await db.billingPlan.delete({ where: { id: fixture.planId } });
  }
});
