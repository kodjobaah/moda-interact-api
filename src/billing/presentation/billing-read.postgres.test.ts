import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import test, { after } from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { BillingPresentationError, BillingPresentationReadService, type BillingPresentationDatabase } from "./billing-read.service.js";
import { BillingPlanCatalogueReadService } from "./plan-catalogue-read.service.js";
import { publishedPricingTranslations } from "../../../tests/helpers/merchant-pricing-test-fixtures.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const suffix = randomUUID();
const freeHandle = `api002_free_${suffix}`;
const paidHandle = `api002_paid_${suffix}`;
const freeCatalogueId = `api002_mp_free_${suffix}`;
const paidCatalogueId = `api002_mp_paid_${suffix}`;
let prisma: PrismaClient | undefined;

function database(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  return prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

function principal(shopId: string, canonicalSiteUrl: string): WooInstallationPrincipal {
  return { installationId: `installation_${suffix}`, shopId, canonicalSiteUrl, credentialVersion: 1 };
}

function uniqueSite(label: string): string {
  return `https://${label}-${suffix}.api002.invalid`;
}

async function removeFixtures(shopIds: string[]): Promise<void> {
  if (!prisma) return;
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  await prisma.billingPlan.deleteMany({ where: { shopifyPlanHandle: { in: [freeHandle, paidHandle] } } });
  await prisma.merchantPricingPlan.deleteMany({ where: { shopifyPlanHandle: { in: [freeHandle, paidHandle] } } });
}

after(async () => {
  if (prisma) await prisma.$disconnect();
});

test("PostgreSQL billing and catalogue reads project persisted Free and downgraded paid Woo state without writes", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const freeDomain = uniqueSite("free");
  const paidDomain = uniqueSite("paid");
  const shopIds: string[] = [];
  const freeProviderContract = `provider-contract-${suffix}`;
  const logger = createLogger({ serviceName: "api002-postgres-test", environment: "test", sink: () => {} });

  try {
    // Serial catalogue inserts keep the migration's dense-position invariant.
    const freeCatalogue = await db.merchantPricingPlan.create({
      data: {
        id: freeCatalogueId,
        shopifyPlanHandle: freeHandle,
        displayName: "Free",
        planKind: "FREE",
        cataloguePosition: 0,
        includedRecoveryCredits: 2,
        allowancePeriod: "LIFETIME",
        billingPeriod: "EVERY_30_DAYS",
        recurringAmountMinor: 0,
        currency: "USD",
        translations: { create: publishedPricingTranslations("Start free") },
      },
    });
    const paidCatalogue = await db.merchantPricingPlan.create({
      data: {
        id: paidCatalogueId,
        shopifyPlanHandle: paidHandle,
        displayName: "Growth",
        planKind: "PAID_METERED",
        cataloguePosition: 1,
        includedRecoveryCredits: 10,
        allowancePeriod: "EVERY_30_DAYS",
        billingPeriod: "EVERY_30_DAYS",
        recurringAmountMinor: 4900,
        currency: "USD",
        translations: { create: publishedPricingTranslations("Growth plan") },
      },
    });
    assert.equal(freeCatalogue.id, freeCatalogueId);
    assert.equal(paidCatalogue.id, paidCatalogueId);

    const [freeOperationalPlan, paidOperationalPlan] = await Promise.all([
      db.billingPlan.create({ data: { shopifyPlanHandle: freeHandle, name: "Operational Free", kind: "FREE" } }),
      db.billingPlan.create({ data: { shopifyPlanHandle: paidHandle, name: "Operational Growth", kind: "PAID_METERED" } }),
    ]);
    const [freeShop, paidShop] = await Promise.all([
      db.shop.create({ data: { domain: freeDomain, platform: "WOOCOMMERCE", onboardingCompleted: true } }),
      db.shop.create({ data: { domain: paidDomain, platform: "WOOCOMMERCE", onboardingCompleted: true } }),
    ]);
    shopIds.push(freeShop.id, paidShop.id);

    await db.subscription.create({
      data: { shopId: freeShop.id, planId: freeOperationalPlan.id, status: "ACTIVE" },
    });
    const periodStart = new Date(Date.now() - 60_000);
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const paidSubscription = await db.subscription.create({
      data: {
        shopId: paidShop.id,
        planId: paidOperationalPlan.id,
        status: "ACTIVE",
        providerSubscriptionId: freeProviderContract,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });
    const paidPeriod = await db.billingPeriod.create({
      data: {
        shopId: paidShop.id,
        subscriptionId: paidSubscription.id,
        planId: paidOperationalPlan.id,
        shopifyPlanHandleSnapshot: paidHandle,
        planKindSnapshot: "PAID_METERED",
        includedRecoveryCreditsGranted: 10,
        periodStart,
        periodEnd,
        entitlementCounters: {
          create: {
            shopId: paidShop.id,
            counter: "INCLUDED_RECOVERY_CREDITS",
            grantedQuantity: 10,
            currentAllowanceQuantity: 4,
            committedQuantity: 6,
            reservedQuantity: 0,
            forfeitedQuantity: 0,
          },
        },
      },
    });
    await db.subscription.update({
      where: { id: paidSubscription.id },
      data: { billingPeriodId: paidPeriod.id },
    });
    await db.shopEntitlementCounter.create({
      data: {
        shopId: freeShop.id,
        counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 2,
        committedQuantity: 1,
        reservedQuantity: 0,
      },
    });

    const billingReader = new BillingPresentationReadService(db);
    const catalogueReader = new BillingPlanCatalogueReadService(db, logger);
    const freePrincipal = principal(freeShop.id, freeDomain);
    const paidPrincipal = principal(paidShop.id, paidDomain);
    const snapshot = async () => ({
      shops: await db.shop.findMany({ where: { id: { in: shopIds } }, orderBy: { id: "asc" }, select: {
        id: true, domain: true, platform: true, shopifyShopId: true, onboardingCompleted: true,
        storeLocale: true, defaultLanguageTag: true, defaultTimeZone: true, defaultCountryCode: true,
      } }),
      subscriptions: await db.subscription.findMany({ where: { shopId: { in: shopIds } }, orderBy: { shopId: "asc" } }),
      counters: await db.shopEntitlementCounter.findMany({ where: { shopId: { in: shopIds } }, orderBy: [{ shopId: "asc" }, { counter: "asc" }] }),
      periods: await db.billingPeriod.findMany({ where: { shopId: { in: shopIds } }, include: { entitlementCounters: true } }),
      operations: await db.billingOperation.count({ where: { shopId: { in: shopIds } } }),
      purchases: await db.recoveryCreditPurchase.count({ where: { shopId: { in: shopIds } } }),
    });
    const before = await snapshot();

    const freeResponse = await billingReader.read(freePrincipal);
    assert.equal(freeResponse.experienceState, "ACTIVE");
    assert.equal(freeResponse.currentPlan?.merchantPricingPlanId, freeCatalogueId);
    assert.deepEqual(freeResponse.capacity.freeLifetime, {
      granted: 2, committed: 1, reserved: 0, remaining: 1,
    });

    const paidResponse = await billingReader.read(paidPrincipal);
    assert.equal(paidResponse.currentPlan?.merchantPricingPlanId, paidCatalogueId);
    assert.deepEqual(paidResponse.capacity.paidIncluded, {
      granted: 10,
      currentAllowance: 4,
      committed: 6,
      reserved: 0,
      forfeited: 0,
      remaining: 0,
    });

    const catalogueResponse = await catalogueReader.read(freePrincipal, "en");
    assert.deepEqual(catalogueResponse.plans.map((plan) => [plan.merchantPricingPlanId, plan.recurringAmountMinor]), [
      [freeCatalogueId, 0],
      [paidCatalogueId, 4900],
    ]);
    assert.equal(catalogueResponse.resolvedLocale, "en");

    const mismatchedPrincipal = principal(paidShop.id, freeDomain);
    await assert.rejects(billingReader.read(mismatchedPrincipal), (error: unknown) =>
      error instanceof BillingPresentationError && error.code === "billing_integrity_invalid",
    );
    await assert.rejects(catalogueReader.read(mismatchedPrincipal, "en"), (error: unknown) =>
      error instanceof BillingPresentationError && error.code === "billing_integrity_invalid",
    );

    const serializedResponses = JSON.stringify([freeResponse, paidResponse, catalogueResponse]);
    for (const sensitiveValue of [freeProviderContract, freeHandle, paidHandle]) {
      assert.equal(serializedResponses.includes(sensitiveValue), false, `response leaked ${sensitiveValue}`);
    }
    assert.equal(serializedResponses.includes("shopifyPlanHandle"), false);
    assert.equal(serializedResponses.includes("providerSubscriptionId"), false);
    assert.deepEqual(await snapshot(), before, "billing/catalogue reads must not mutate durable state");

    // ARCH-041-API-002: keep both stages of a billing read on the same MVCC
    // snapshot even when another connection updates a counter between them.
    // Intercept only the test transaction's first Shop SELECT; production code
    // retains the original callback and RepeatableRead isolation unchanged.
    let signalShopRead: () => void = () => {};
    let resumeRead: () => void = () => {};
    const shopRead = new Promise<void>((resolve) => { signalShopRead = resolve; });
    const proceed = new Promise<void>((resolve) => { resumeRead = resolve; });
    const pausedDatabase = {
      $transaction: (callback: (transaction: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => {
        assert.deepEqual(options, { isolationLevel: "RepeatableRead" });
        return db.$transaction(async (transaction) => callback(new Proxy(transaction, {
          get(target, property) {
            if (property !== "shop") return Reflect.get(target, property);
            return {
              findUnique: async (query: Prisma.ShopFindUniqueArgs) => {
                const shop = await target.shop.findUnique(query);
                signalShopRead();
                await proceed;
                return shop;
              },
            };
          },
        })), { isolationLevel: "RepeatableRead" });
      },
    } as unknown as BillingPresentationDatabase;
    const pausedRead = new BillingPresentationReadService(pausedDatabase).read(freePrincipal);
    await shopRead;
    try {
      await db.shopEntitlementCounter.update({
        where: { shopId_counter: { shopId: freeShop.id, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
        data: { committedQuantity: 0 },
      });
    } finally {
      resumeRead();
    }
    const consistentRead = await pausedRead;
    assert.deepEqual(consistentRead.capacity.freeLifetime, {
      granted: 2, committed: 1, reserved: 0, remaining: 1,
    }, "the second query stage must not see a newer committed counter version");
    assert.equal((await db.shopEntitlementCounter.findUniqueOrThrow({
      where: { shopId_counter: { shopId: freeShop.id, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
    })).committedQuantity, 0, "the concurrent update really committed");
  } finally {
    await removeFixtures(shopIds);
  }
});