import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test, { after, before } from "node:test";
import { WooConnectionConflictError, WooInstallationConnectionService } from "./connection-service.js";
import {
  FreePlanConfigurationUnavailableError,
  InitialFreeActivationConflictError,
} from "../billing/initial-free-activation.service.js";
import { digestSecret } from "./credential.js";
import { WooSiteVerifier } from "./site-verifier.js";
import { canonicalizeWooSiteUrl } from "./site-url.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
let prisma: PrismaClient | undefined;
const freePlanHandle = `woo-free-${randomUUID()}`;
let checkoutFeatureId: string | undefined;

function database(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  return prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

function service(verify: () => Promise<void> = async () => {}): WooInstallationConnectionService {
  const verifier = new WooSiteVerifier({ mode: "public" });
  verifier.verify = verify;
  return new WooInstallationConnectionService(database(), verifier);
}

function makeInput(siteUrl: string) {
  return {
    site: canonicalizeWooSiteUrl(siteUrl, "public"),
    attemptId: randomUUID(),
    bootstrapSecret: Buffer.alloc(32, 9),
  };
}

function uniqueSite(): string {
  return `https://${randomUUID()}.woo-integration.invalid`;
}

async function removeSite(siteUrl: string): Promise<void> {
  if (!prisma) return;
  await prisma.shop.deleteMany({ where: { domain: siteUrl } });
}

async function restorePlatformBillingPolicy(): Promise<void> {
  await database().platformBillingPolicy.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      lifetimeFreeRecoveryAllowance: 7,
      absoluteOutboundHardLimit: 10000,
      defaultWarningPercent: 80,
    },
    update: { lifetimeFreeRecoveryAllowance: 7 },
  });
}

before(async () => {
  if (!databaseUrl) return;
  const feature = await database().feature.create({
    data: {
      key: "checkout_recovery",
      displayName: "Checkout recovery test feature",
      activationMode: "ALWAYS_ENABLED",
      systemRequired: true,
    },
  });
  checkoutFeatureId = feature.id;
  await database().merchantPricingPlan.create({
    data: {
      shopifyPlanHandle: freePlanHandle,
      displayName: "Woo Free test plan",
      planKind: "FREE",
      isActive: true,
      cataloguePosition: 1,
      includedRecoveryCredits: 91,
      allowancePeriod: "LIFETIME",
      billingPeriod: "EVERY_30_DAYS",
      recurringAmountMinor: 0,
      currency: "USD",
      features: {
        create: { featureId: feature.id, configuration: {} },
      },
    },
  });
  await restorePlatformBillingPolicy();
});

async function twoPartyBarrier(): Promise<() => Promise<void>> {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  let arrivals = 0;
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await opened;
  };
}

test("PostgreSQL first connect atomically creates Shop, installation, ACTIVE Free Subscription, and lifetime counter", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  const input = makeInput(siteUrl);
  try {
    const result = await service().connect(input);
    const [shop, installation, subscription, counter, billingPlan] = await Promise.all([
      database().shop.findUniqueOrThrow({ where: { id: result.shopId }, include: { settings: true } }),
      database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: result.installationId } }),
      database().subscription.findUniqueOrThrow({ where: { shopId: result.shopId } }),
      database().shopEntitlementCounter.findUniqueOrThrow({
        where: { shopId_counter: { shopId: result.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
      }),
      database().billingPlan.findUniqueOrThrow({ where: { shopifyPlanHandle: freePlanHandle } }),
    ]);
    assert.equal(result.connection, "CREATED");
    assert.equal(result.credentialVersion, 1);
    assert.equal(shop.platform, "WOOCOMMERCE");
    assert.equal(shop.shopifyShopId, null);
    assert.equal(shop.domain, siteUrl);
    assert.equal(shop.status, "ACTIVE");
    assert.equal(shop.onboardingCompleted, true);
    assert.equal(shop.settings, null);
    assert.equal(installation.shopId, shop.id);
    assert.equal(subscription.status, "ACTIVE");
    assert.equal(subscription.planId, billingPlan.id);
    assert.equal(subscription.providerSubscriptionId, null);
    assert.equal(subscription.observedShopifyPlanHandle, null);
    assert.equal(subscription.billingPeriodId, null);
    assert.equal(subscription.currentPeriodStart, null);
    assert.equal(subscription.currentPeriodEnd, null);
    assert.equal(subscription.trialEndsAt, null);
    assert.equal(subscription.pendingPlanId, null);
    assert.equal(subscription.lastProviderLifecycleState, null);
    assert.equal(counter.grantedQuantity, 7);
    assert.equal(counter.committedQuantity, 0);
    assert.equal(counter.reservedQuantity, 0);
    assert.equal(counter.refundingQuantity, 0);
    assert.equal(await database().subscription.count({ where: { shopId: shop.id } }), 1);
    assert.equal(await database().billingPeriod.count({ where: { shopId: shop.id } }), 0);
    assert.equal(await database().billingPeriodEntitlementCounter.count({ where: { shopId: shop.id } }), 0);
    const [operations, purchases, usageEvents, webhookReceipts] = await Promise.all([
      database().billingOperation.count({ where: { shopId: shop.id } }),
      database().recoveryCreditPurchase.count({ where: { shopId: shop.id } }),
      database().usageEvent.count({ where: { shopId: shop.id } }),
      database().wooCommerceBillingWebhookReceipt.count(),
    ]);
    assert.equal(operations, 0);
    assert.equal(purchases, 0);
    assert.equal(usageEvents, 0);
    assert.equal(webhookReceipts, 0);
    assert.ok(await database().merchantPricingPlan.findUniqueOrThrow({
      where: { shopifyPlanHandle: freePlanHandle },
      select: { materializedAt: true },
    }).then((catalogue) => catalogue.materializedAt));
    assert.equal(billingPlan.kind, "FREE");
    assert.equal(billingPlan.active, true);
    assert.deepEqual(Buffer.from(installation.credentialDigest), digestSecret(Buffer.from(result.credential, "base64url")));
    assert.notDeepEqual(Buffer.from(installation.credentialDigest), digestSecret(input.bootstrapSecret));
    assert.notEqual(Buffer.from(installation.credentialDigest).toString("base64url"), result.credential);
  } finally {
    await removeSite(siteUrl);
  }
});

test("PostgreSQL reconnect preserves tenant state and rotates only the installation credential", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  try {
    const initial = await service().connect(makeInput(siteUrl));
    const counterKey = {
      shopId_counter: {
        shopId: initial.shopId,
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
    };
    await database().shopEntitlementCounter.update({
      where: counterKey,
      data: { committedQuantity: 3, reservedQuantity: 2, refundingQuantity: 1 },
    });
    const subscriptionBefore = await database().subscription.findUniqueOrThrow({ where: { shopId: initial.shopId } });
    const counterBefore = await database().shopEntitlementCounter.findUniqueOrThrow({ where: counterKey });
    await database().shop.update({
      where: { id: initial.shopId },
      data: {
        status: "UNINSTALLED",
        uninstalledAt: new Date("2026-01-01T00:00:00Z"),
        reinstallPendingAt: new Date("2026-01-02T00:00:00Z"),
        onboardingCompleted: true,
        wooCommerceInstallation: {
          update: { status: "REVOKED", revokedAt: new Date("2026-01-03T00:00:00Z") },
        },
        settings: { create: { onboardingCompleted: true, plan: "fixture-plan" } },
      },
    });
    const reconnect = await service().connect(makeInput(siteUrl));
    const shop = await database().shop.findUniqueOrThrow({ where: { id: initial.shopId }, include: { settings: true } });
    const installation = await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } });
    const subscriptionAfter = await database().subscription.findUniqueOrThrow({ where: { shopId: initial.shopId } });
    const counterAfter = await database().shopEntitlementCounter.findUniqueOrThrow({ where: counterKey });
    assert.equal(reconnect.connection, "RECONNECTED");
    assert.equal(reconnect.shopId, initial.shopId);
    assert.equal(reconnect.installationId, initial.installationId);
    assert.equal(reconnect.credentialVersion, initial.credentialVersion + 1);
    assert.notEqual(reconnect.credential, initial.credential);
    assert.equal(shop.status, "ACTIVE");
    assert.equal(shop.uninstalledAt, null);
    assert.equal(shop.reinstallPendingAt, null);
    assert.equal(shop.onboardingCompleted, true);
    assert.equal(shop.settings?.plan, "fixture-plan");
    assert.equal(shop.settings?.onboardingCompleted, true);
    assert.deepEqual(subscriptionAfter, subscriptionBefore);
    assert.deepEqual(counterAfter, counterBefore);
    assert.equal(counterAfter.grantedQuantity, 7);
    assert.equal(counterAfter.committedQuantity, 3);
    assert.equal(counterAfter.reservedQuantity, 2);
    assert.equal(counterAfter.refundingQuantity, 1);
    assert.equal(await database().shopEntitlementCounter.count({ where: { shopId: shop.id } }), 1);
    assert.deepEqual(Buffer.from(installation.credentialDigest), digestSecret(Buffer.from(reconnect.credential, "base64url")));
  } finally {
    await removeSite(siteUrl);
  }
});

test("PostgreSQL concurrent first connects leave one tenant and one bounded loser", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  const barrier = await twoPartyBarrier();
  try {
    const attempts = await Promise.allSettled([
      service(barrier).connect(makeInput(siteUrl)),
      service(barrier).connect(makeInput(siteUrl)),
    ]);
    const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
    const losers = attempts.filter((attempt) => attempt.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(losers[0]?.status === "rejected" && losers[0].reason instanceof WooConnectionConflictError);
    assert.equal(await database().shop.count({ where: { domain: siteUrl } }), 1);
    assert.equal(await database().wooCommerceInstallation.count({ where: { canonicalSiteUrl: siteUrl } }), 1);
    const winner = winners[0];
    assert.ok(winner?.status === "fulfilled");
    assert.equal(await database().subscription.count({ where: { shopId: winner.value.shopId } }), 1);
    assert.equal(await database().shopEntitlementCounter.count({ where: { shopId: winner.value.shopId } }), 1);
    const counter = await database().shopEntitlementCounter.findUniqueOrThrow({
      where: { shopId_counter: { shopId: winner.value.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
    });
    assert.equal(counter.grantedQuantity, 7);
  } finally {
    await removeSite(siteUrl);
  }
});

test("PostgreSQL concurrent reconnects use credential-version CAS so one returned credential wins", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  try {
    const initial = await service().connect(makeInput(siteUrl));
    const barrier = await twoPartyBarrier();
    const attempts = await Promise.allSettled([
      service(barrier).connect(makeInput(siteUrl)),
      service(barrier).connect(makeInput(siteUrl)),
    ]);
    const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
    const losers = attempts.filter((attempt) => attempt.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(losers[0]?.status === "rejected" && losers[0].reason instanceof WooConnectionConflictError);
    const winner = winners[0];
    assert.ok(winner?.status === "fulfilled");
    const installation = await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } });
    assert.equal(installation.credentialVersion, initial.credentialVersion + 1);
    assert.deepEqual(Buffer.from(installation.credentialDigest), digestSecret(Buffer.from(winner.value.credential, "base64url")));
  } finally {
    await removeSite(siteUrl);
  }
});

test("PostgreSQL suspended Shop reconnect is rejected without changing installation state", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  try {
    const initial = await service().connect(makeInput(siteUrl));
    await database().shop.update({ where: { id: initial.shopId }, data: { status: "SUSPENDED" } });
    const before = await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } });
    await assert.rejects(service().connect(makeInput(siteUrl)), WooConnectionConflictError);
    const after = await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } });
    assert.deepEqual(after, before);
  } finally {
    await removeSite(siteUrl);
  }
});

test("PostgreSQL different Shops concurrently materialize and reuse one operational Free plan", {
  skip: !databaseUrl,
}, async () => {
  const siteUrls = [uniqueSite(), uniqueSite()];
  const barrier = await twoPartyBarrier();
  try {
    await database().billingPlan.deleteMany({ where: { shopifyPlanHandle: freePlanHandle } });
    await database().merchantPricingPlan.update({
      where: { shopifyPlanHandle: freePlanHandle },
      data: { materializedAt: null },
    });
    const results = await Promise.all(siteUrls.map((siteUrl) => service(barrier).connect(makeInput(siteUrl))));
    const plans = await database().billingPlan.findMany({ where: { shopifyPlanHandle: freePlanHandle } });
    const subscriptions = await database().subscription.findMany({ where: { shopId: { in: results.map((result) => result.shopId) } } });
    assert.equal(plans.length, 1);
    assert.equal(subscriptions.length, 2);
    assert.deepEqual(new Set(subscriptions.map((subscription) => subscription.planId)), new Set([plans[0]?.id]));
    assert.equal(await database().merchantPricingPlan.findUniqueOrThrow({
      where: { shopifyPlanHandle: freePlanHandle },
      select: { materializedAt: true },
    }).then((catalogue) => catalogue.materializedAt !== null), true);
  } finally {
    await Promise.all(siteUrls.map(removeSite));
  }
});

test("PostgreSQL onboarded reconnect does not recreate a missing lifetime counter", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  try {
    const initial = await service().connect(makeInput(siteUrl));
    await database().shopEntitlementCounter.deleteMany({ where: { shopId: initial.shopId } });
    await database().merchantPricingPlan.update({
      where: { shopifyPlanHandle: freePlanHandle },
      data: { recurringAmountMinor: 1 },
    });
    const reconnect = await service().connect(makeInput(siteUrl));
    assert.equal(reconnect.shopId, initial.shopId);
    assert.equal(await database().shopEntitlementCounter.count({ where: { shopId: initial.shopId } }), 0);
  } finally {
    await database().merchantPricingPlan.update({
      where: { shopifyPlanHandle: freePlanHandle },
      data: { recurringAmountMinor: 0 },
    });
    await removeSite(siteUrl);
  }
});

test("PostgreSQL onboarded paid Shop reconnect preserves paid state when Free catalogue is invalid", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  const paidPlanHandle = `woo-paid-${randomUUID()}`;
  try {
    const initial = await service().connect(makeInput(siteUrl));
    const paidPlan = await database().billingPlan.create({
      data: {
        shopifyPlanHandle: paidPlanHandle,
        name: "Existing paid plan",
        kind: "PAID_METERED",
        active: true,
      },
    });
    await database().subscription.update({
      where: { shopId: initial.shopId },
      data: {
        planId: paidPlan.id,
        status: "ACTIVE",
        observedShopifyPlanHandle: paidPlanHandle,
        providerSubscriptionId: "existing-provider-contract",
      },
    });
    await database().shop.update({
      where: { id: initial.shopId },
      data: { status: "UNINSTALLED", onboardingCompleted: true },
    });
    await database().shopEntitlementCounter.create({
      data: {
        shopId: initial.shopId,
        counter: "PURCHASED_RECOVERY_CREDITS",
        grantedQuantity: 12,
        committedQuantity: 4,
        reservedQuantity: 3,
        refundingQuantity: 2,
      },
    });
    const subscriptionBefore = await database().subscription.findUniqueOrThrow({ where: { shopId: initial.shopId } });
    const countersBefore = await database().shopEntitlementCounter.findMany({ where: { shopId: initial.shopId }, orderBy: { counter: "asc" } });
    await database().merchantPricingPlan.update({
      where: { shopifyPlanHandle: freePlanHandle },
      data: { isActive: false },
    });

    const reconnect = await service().connect(makeInput(siteUrl));

    assert.equal(reconnect.shopId, initial.shopId);
    assert.deepEqual(await database().subscription.findUniqueOrThrow({ where: { shopId: initial.shopId } }), subscriptionBefore);
    assert.deepEqual(
      await database().shopEntitlementCounter.findMany({ where: { shopId: initial.shopId }, orderBy: { counter: "asc" } }),
      countersBefore,
    );
    assert.equal((await database().shop.findUniqueOrThrow({ where: { id: initial.shopId } })).onboardingCompleted, true);
  } finally {
    await database().merchantPricingPlan.update({
      where: { shopifyPlanHandle: freePlanHandle },
      data: { isActive: true },
    });
    await removeSite(siteUrl);
    await database().billingPlan.deleteMany({ where: { shopifyPlanHandle: paidPlanHandle } });
  }
});

test("PostgreSQL never-onboarded subscription conflict preserves billing and credential state", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  try {
    const initial = await service().connect(makeInput(siteUrl));
    await database().shop.update({ where: { id: initial.shopId }, data: { onboardingCompleted: false } });
    await database().subscription.update({
      where: { shopId: initial.shopId },
      data: { providerSubscriptionId: "legacy-provider-contract" },
    });
    const installationBefore = await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } });
    const subscriptionBefore = await database().subscription.findUniqueOrThrow({ where: { shopId: initial.shopId } });
    await assert.rejects(service().connect(makeInput(siteUrl)), InitialFreeActivationConflictError);
    assert.deepEqual(
      await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } }),
      installationBefore,
    );
    assert.deepEqual(await database().subscription.findUniqueOrThrow({ where: { shopId: initial.shopId } }), subscriptionBefore);
    assert.equal((await database().shop.findUniqueOrThrow({ where: { id: initial.shopId } })).onboardingCompleted, false);
  } finally {
    await removeSite(siteUrl);
  }
});

test("PostgreSQL invalid Free catalogue rolls back first connect and reconnect credential rotation", {
  skip: !databaseUrl,
}, async () => {
  const firstSite = uniqueSite();
  const reconnectSite = uniqueSite();
  try {
    await database().billingPlan.deleteMany({ where: { shopifyPlanHandle: freePlanHandle } });
    await database().merchantPricingPlan.update({
      where: { shopifyPlanHandle: freePlanHandle },
      data: { recurringAmountMinor: 1, materializedAt: null },
    });
    await assert.rejects(service().connect(makeInput(firstSite)), FreePlanConfigurationUnavailableError);
    assert.equal(await database().shop.count({ where: { domain: firstSite } }), 0);
    assert.equal(await database().wooCommerceInstallation.count({ where: { canonicalSiteUrl: firstSite } }), 0);
    assert.equal(await database().billingPlan.count({ where: { shopifyPlanHandle: freePlanHandle } }), 0);
    assert.equal(await database().merchantPricingPlan.findUniqueOrThrow({
      where: { shopifyPlanHandle: freePlanHandle },
      select: { materializedAt: true },
    }).then((catalogue) => catalogue.materializedAt), null);

    await database().merchantPricingPlan.update({
      where: { shopifyPlanHandle: freePlanHandle },
      data: { recurringAmountMinor: 0 },
    });
    const initial = await service().connect(makeInput(reconnectSite));
    await database().shop.update({
      where: { id: initial.shopId },
      data: { onboardingCompleted: false, status: "UNINSTALLED" },
    });
    await database().subscription.delete({ where: { shopId: initial.shopId } });
    const installationBefore = await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } });
    await database().merchantPricingPlan.update({
      where: { shopifyPlanHandle: freePlanHandle },
      data: { recurringAmountMinor: 1 },
    });
    await assert.rejects(service().connect(makeInput(reconnectSite)), FreePlanConfigurationUnavailableError);
    assert.deepEqual(
      await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } }),
      installationBefore,
    );
    const shop = await database().shop.findUniqueOrThrow({ where: { id: initial.shopId } });
    assert.equal(shop.status, "UNINSTALLED");
    assert.equal(shop.onboardingCompleted, false);
  } finally {
    await database().merchantPricingPlan.update({
      where: { shopifyPlanHandle: freePlanHandle },
      data: { recurringAmountMinor: 0 },
    });
    await Promise.all([removeSite(firstSite), removeSite(reconnectSite)]);
  }
});

test("PostgreSQL missing first-grant policy rolls back Shop and installation creation", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  try {
    await database().billingPlan.deleteMany({ where: { shopifyPlanHandle: freePlanHandle } });
    await database().merchantPricingPlan.update({
      where: { shopifyPlanHandle: freePlanHandle },
      data: { materializedAt: null },
    });
    await database().platformBillingPolicy.delete({ where: { id: "default" } });
    await assert.rejects(service().connect(makeInput(siteUrl)), FreePlanConfigurationUnavailableError);
    assert.equal(await database().shop.count({ where: { domain: siteUrl } }), 0);
    assert.equal(await database().wooCommerceInstallation.count({ where: { canonicalSiteUrl: siteUrl } }), 0);
    assert.equal(await database().billingPlan.count({ where: { shopifyPlanHandle: freePlanHandle } }), 0);
    assert.equal(await database().merchantPricingPlan.findUniqueOrThrow({
      where: { shopifyPlanHandle: freePlanHandle },
      select: { materializedAt: true },
    }).then((catalogue) => catalogue.materializedAt), null);
  } finally {
    await restorePlatformBillingPolicy();
    await removeSite(siteUrl);
  }
});

after(async () => {
  if (prisma && databaseUrl) {
    await prisma.billingPlan.deleteMany({ where: { shopifyPlanHandle: freePlanHandle } });
    await prisma.merchantPricingPlan.deleteMany({ where: { shopifyPlanHandle: freePlanHandle } });
    if (checkoutFeatureId) await prisma.feature.deleteMany({ where: { id: checkoutFeatureId } });
  }
  await prisma?.$disconnect();
});