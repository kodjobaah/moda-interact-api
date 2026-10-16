import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../../../src/woocommerce/installation/authenticator.js";
import {
  RecoveryCreditPurchaseCommandError,
  RecoveryCreditPurchaseCommandService,
} from "../../../../src/billing/commands/recovery-credit-purchase-command.service.js";
import { publishedPricingTranslations } from "../../../helpers/merchant-pricing-test-fixtures.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
let prisma: PrismaClient | undefined;
const shopDomains: string[] = [];
const catalogueIds: string[] = [];
const billingPlanHandles: string[] = [];

function database(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  return prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

async function createFixture() {
  const db = database();
  const feature = await db.feature.findUnique({ where: { key: "checkout_recovery" } }) ??
    await db.feature.create({
      data: { key: "checkout_recovery", displayName: "Checkout recovery", activationMode: "ALWAYS_ENABLED", systemRequired: true },
    });
  const handle = `api007_${suffix}`;
  const catalogueId = `api007_catalogue_${suffix}`;
  catalogueIds.push(catalogueId);
  billingPlanHandles.push(handle);
  const catalogue = await db.merchantPricingPlan.create({
    data: {
      id: catalogueId,
      shopifyPlanHandle: handle,
      displayName: "API-007 concurrent provider references",
      planKind: "FREE",
      isActive: true,
      cataloguePosition: 0,
      includedRecoveryCredits: 10,
      allowancePeriod: "LIFETIME",
      billingPeriod: "EVERY_30_DAYS",
      recurringAmountMinor: 0,
      currency: "USD",
      translations: { create: publishedPricingTranslations("Test provider outcome") },
      features: { create: { featureId: feature.id, configuration: {} } },
    },
  });
  const plan = await db.billingPlan.create({
    data: { shopifyPlanHandle: handle, name: "API-007 Free", kind: "FREE" },
  });
  const bundle = await db.merchantPricingUsageEvent.create({
    data: {
      merchantPricingPlanId: catalogue.id,
      eventHandle: `api007_bundle_${suffix}`,
      adminLabel: "Recovery credit bundle",
      creditsGrantedPerUnit: 25,
      position: 0,
      pricingMode: "FIXED",
      fixedUnitAmountMinor: 1999,
      currency: "USD",
      maximumUnitsPerBillingPeriod: null,
    },
  });
  const shops: Array<{ id: string; principal: WooInstallationPrincipal; requestKey: string }> = [];
  for (const name of ["a", "b"]) {
    const domain = `https://api007-${name}-${suffix}.invalid`;
    shopDomains.push(domain);
    const shop = await db.shop.create({
      data: { domain, platform: "WOOCOMMERCE", onboardingCompleted: true },
    });
    await db.subscription.create({
      data: { shopId: shop.id, planId: plan.id, status: "ACTIVE", providerSubscriptionId: null },
    });
    shops.push({
      id: shop.id,
      principal: {
        installationId: `api007-install-${name}-${suffix}`,
        shopId: shop.id,
        canonicalSiteUrl: domain,
        credentialVersion: 1,
      },
      requestKey: `api007-${name}-${suffix}`,
    });
  }
  return { bundle, shops };
}

after(async () => {
  if (!prisma) return;
  try {
    await prisma.shop.deleteMany({ where: { domain: { in: shopDomains } } });
    await prisma.billingPlan.deleteMany({ where: { shopifyPlanHandle: { in: billingPlanHandles } } });
    await prisma.merchantPricingPlan.deleteMany({ where: { id: { in: catalogueIds } } });
  } finally {
    await prisma.$disconnect();
  }
});

test("PostgreSQL simultaneous cross-shop charge responses with one provider ID allow one reference only", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const { bundle, shops } = await createFixture();
  const [first, second] = shops as [typeof shops[number], typeof shops[number]];
  const reference = randomUUID();
  let calls = 0;
  let releaseProvider!: () => void;
  const releaseGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const service = new RecoveryCreditPurchaseCommandService(db, {
    createCharge: async () => {
      calls += 1;
      if (calls === 2) releaseProvider();
      await Promise.race([
        releaseGate,
        new Promise<never>((_, reject) => {
          // Never hang the test indefinitely if an admission bug prevents one call.
          const timer = setTimeout(() => reject(new Error("second provider request did not arrive")), 20_000);
          timer.unref();
        }),
      ]);
      return { id: reference, confirmation_url: "https://woocommerce.com/checkout/charge" };
    },
  }, "production");

  const results = await Promise.allSettled([
    service.initiate(first.principal, first.requestKey, bundle.id),
    service.initiate(second.principal, second.requestKey, bundle.id),
  ]);
  assert.equal(calls, 2);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  const rejected = results.find((item) => item.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof RecoveryCreditPurchaseCommandError);
  assert.equal(rejected.reason.statusCode, 502);
  assert.equal(rejected.reason.code, "billing_provider_outcome_unknown");
  assert.equal(rejected.reason.safeProviderCode, "PROVIDER_CONTRACT_COLLISION");
  assert.ok(rejected.reason.purchaseId);

  const operations = await db.billingOperation.findMany({
    where: { shopId: { in: shops.map((shop) => shop.id) } },
  });
  assert.equal(operations.length, 2);
  const accepted = operations.find((operation) => operation.state === "AWAITING_CONFIRMATION");
  const ambiguous = operations.find((operation) => operation.state === "OUTCOME_UNKNOWN");
  assert.ok(accepted);
  assert.ok(ambiguous);
  assert.equal(accepted.providerReference, reference);
  assert.equal(ambiguous.providerReference, null);
  assert.equal(ambiguous.lastErrorCode, "PROVIDER_CONTRACT_COLLISION");
  assert.equal(ambiguous.confirmationUrl, null);

  const purchases = await db.recoveryCreditPurchase.findMany({
    where: { shopId: { in: shops.map((shop) => shop.id) } },
  });
  assert.equal(purchases.length, 2);
  for (const purchase of purchases) {
    assert.equal(purchase.status, "REQUESTED", "a provider response must not grant credits");
    assert.equal(purchase.currentAmount, 0);
    assert.equal(purchase.reservedAmount, 0);
    assert.equal(purchase.activatedAt, null);
  }
  assert.equal(await db.usageEvent.count({ where: { shopId: { in: shops.map((shop) => shop.id) } } }), 0);

  const acceptedShop = shops.find((shop) => shop.id === accepted.shopId)!;
  const ambiguousShop = shops.find((shop) => shop.id === ambiguous.shopId)!;
  const replay = await service.initiate(acceptedShop.principal, acceptedShop.requestKey, bundle.id);
  assert.equal(replay.operationId, accepted.id);
  assert.equal(replay.state, "AWAITING_CONFIRMATION");
  await assert.rejects(
    service.initiate(ambiguousShop.principal, ambiguousShop.requestKey, bundle.id),
    (error: unknown) => error instanceof RecoveryCreditPurchaseCommandError &&
      error.statusCode === 409 && error.code === "billing_provider_outcome_unknown" &&
      error.safeProviderCode === "PROVIDER_CONTRACT_COLLISION",
  );
  assert.equal(calls, 2, "replaying either persisted outcome must not issue another charge");
});
