import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { RecurringBillingCommandError } from "../../../../src/billing/commands/recurring-command-error.js";
import { RecurringOutcomePersistence } from "../../../../src/billing/commands/recurring-outcome.js";
import { publishedPricingTranslations } from "../../../helpers/merchant-pricing-test-fixtures.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

test("PostgreSQL serializes simultaneous provider-reference collisions across merchants", {
  skip: !databaseUrl,
}, async () => {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  const suffix = randomUUID().replaceAll("-", "");
  const shopDomains: string[] = [];
  const planId = `api005_plan_${suffix}`;
  const planHandle = `api005_handle_${suffix}`;

  try {
    const feature = await db.feature.findUnique({ where: { key: "checkout_recovery" } }) ??
      await db.feature.create({ data: {
        key: "checkout_recovery", displayName: "Checkout recovery",
        activationMode: "ALWAYS_ENABLED", systemRequired: true,
      } });
    const catalogue = await db.merchantPricingPlan.create({
      data: {
        id: planId,
        shopifyPlanHandle: planHandle,
        displayName: `API-005 ${suffix}`,
        planKind: "PAID_METERED",
        isActive: true,
        cataloguePosition: 0,
        includedRecoveryCredits: 30,
        allowancePeriod: "EVERY_30_DAYS",
        billingPeriod: "EVERY_30_DAYS",
        recurringAmountMinor: 4900,
        currency: "USD",
        translations: { create: publishedPricingTranslations("API-005") },
        features: { create: { featureId: feature.id, configuration: {} } },
      },
    });

    const shops = [];
    for (const index of [1, 2]) {
      const domain = `https://api005-${index}-${suffix}.invalid`;
      shopDomains.push(domain);
      shops.push(await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", onboardingCompleted: true } }));
    }

    const operations = [];
    for (const [index, shop] of shops.entries()) {
      operations.push(await db.billingOperation.create({
        data: {
          shopId: shop.id,
          kind: "SUBSCRIPTION_CREATE",
          state: "INITIATING",
          requestKey: `api005-simultaneous-${index}-${suffix}`,
          requestFingerprint: new Uint8Array(32).fill(index + 1),
          merchantPricingPlanId: catalogue.id,
          quotedAmountMinor: catalogue.recurringAmountMinor,
          quotedCurrency: catalogue.currency,
          quotedBillingPeriod: catalogue.billingPeriod,
        },
      }));
    }

    const evidence = {
      id: `woo_same_contract_${suffix}`,
      confirmationUrl: "https://woocommerce.com/checkout/confirmed",
    };
    const outcomes = new RecurringOutcomePersistence(db, "production");
    const results = await Promise.allSettled(operations.map((operation) =>
      outcomes.confirmSubscription(operation, evidence),
    ));

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.status === "rejected" && rejected[0].reason instanceof RecurringBillingCommandError);
    if (rejected[0]?.status === "rejected") {
      assert.equal(rejected[0].reason.statusCode, 502);
      assert.equal(rejected[0].reason.code, "billing_provider_outcome_unknown");
      assert.equal(rejected[0].reason.safeProviderCode, "PROVIDER_CONTRACT_COLLISION");
    }

    const persisted = await db.billingOperation.findMany({
      where: { id: { in: operations.map((operation) => operation.id) } },
      orderBy: { id: "asc" },
    });
    assert.deepEqual(persisted.map((operation) => operation.state).sort(), ["AWAITING_CONFIRMATION", "OUTCOME_UNKNOWN"]);
    const assigned = persisted.filter((operation) => operation.providerReference === evidence.id);
    assert.equal(assigned.length, 1, "one provider contract must not belong to two shops");
    assert.equal(assigned[0]?.state, "AWAITING_CONFIRMATION");
    const collided = persisted.find((operation) => operation.state === "OUTCOME_UNKNOWN");
    assert.equal(collided?.providerReference, null);
    assert.equal(collided?.confirmationUrl, null);
    assert.equal(collided?.lastErrorCode, "PROVIDER_CONTRACT_COLLISION");
  } finally {
    // Cleanup runs even when assertion fails; no shared/test tenant rows are removed.
    try {
      await db.shop.deleteMany({ where: { domain: { in: shopDomains } } });
      await db.merchantPricingPlan.deleteMany({ where: { id: planId } });
    } finally {
      await db.$disconnect();
    }
  }
});
