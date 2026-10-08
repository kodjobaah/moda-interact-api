import {
  BillingPlanKind,
  EntitlementCounter,
  MerchantPricingAllowancePeriod,
  MerchantPricingPlanKind,
  Prisma,
  SubscriptionProjectionStatus,
  type BillingPlan,
  type MerchantPricingPlan,
} from "@prisma/client";
import { MerchantKnowledgeFeatureConfigurationSchema } from "@modainteract/moda-interact-shared/merchant-knowledge";

export class FreePlanConfigurationUnavailableError extends Error {
  constructor() {
    super("free_plan_configuration_unavailable");
    this.name = "FreePlanConfigurationUnavailableError";
  }
}

export class InitialFreeActivationConflictError extends Error {
  constructor() {
    super("initial_free_activation_conflict");
    this.name = "InitialFreeActivationConflictError";
  }
}

export class RetryFreeActivationTransactionError extends Error {
  constructor() {
    super("retry_free_activation_transaction");
    this.name = "RetryFreeActivationTransactionError";
  }
}

type FreeCataloguePlan = MerchantPricingPlan & {
  features: Array<{
    featureId: string;
    configuration: Prisma.JsonValue;
    feature: { key: string; systemRequired: boolean } | null;
  }>;
};

export class InitialWooFreeActivationService {
  async activate(transaction: Prisma.TransactionClient, shopId: string): Promise<"ACTIVATED_FREE" | "ALREADY_ONBOARDED"> {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "commerce"."Shop"
      WHERE "id" = ${shopId}
      FOR UPDATE
    `);
    const shop = await transaction.shop.findUnique({
      where: { id: shopId },
      select: { id: true, onboardingCompleted: true },
    });
    if (!shop) throw new FreePlanConfigurationUnavailableError();
    if (shop.onboardingCompleted) return "ALREADY_ONBOARDED";

    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "billing"."Subscription"
      WHERE "shopId" = ${shopId}
      FOR UPDATE
    `);
    const subscription = await transaction.subscription.findUnique({
      where: { shopId },
    });
    if (subscription && !isEmptyInitialSubscription(subscription)) {
      throw new InitialFreeActivationConflictError();
    }

    const cataloguePlans = await transaction.merchantPricingPlan.findMany({
      where: { planKind: MerchantPricingPlanKind.FREE },
      include: { features: { include: { feature: true } } },
    });
    if (cataloguePlans.length !== 1) throw new FreePlanConfigurationUnavailableError();
    const catalogue = cataloguePlans[0] as FreeCataloguePlan | undefined;
    if (!catalogue || !isValidFreeCataloguePlan(catalogue)) {
      throw new FreePlanConfigurationUnavailableError();
    }

    const plan = await this.resolveOperationalPlan(transaction, catalogue);
    const lifetimeCounter = await transaction.shopEntitlementCounter.findUnique({
      where: {
        shopId_counter: {
          shopId,
          counter: EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS,
        },
      },
    });
    const policy = lifetimeCounter
      ? null
      : await transaction.platformBillingPolicy.findUnique({ where: { id: "default" } });
    if (
      !lifetimeCounter &&
      (!policy || !Number.isSafeInteger(policy.lifetimeFreeRecoveryAllowance) || policy.lifetimeFreeRecoveryAllowance < 0)
    ) {
      throw new FreePlanConfigurationUnavailableError();
    }

    await transaction.subscription.upsert({
      where: { shopId },
      update: freeSubscriptionProjection(plan.id),
      create: { shopId, ...freeSubscriptionProjection(plan.id) },
    });
    if (!lifetimeCounter) {
      try {
        await transaction.shopEntitlementCounter.create({
          data: {
            shopId,
            counter: EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS,
            grantedQuantity: policy!.lifetimeFreeRecoveryAllowance,
            committedQuantity: 0,
            reservedQuantity: 0,
            refundingQuantity: 0,
          },
        });
      } catch (error) {
        if (isPrismaCode(error, "P2002")) throw new RetryFreeActivationTransactionError();
        throw error;
      }
    }
    await transaction.shop.update({
      where: { id: shopId },
      data: { onboardingCompleted: true },
    });
    return "ACTIVATED_FREE";
  }

  private async resolveOperationalPlan(
    transaction: Prisma.TransactionClient,
    catalogue: FreeCataloguePlan,
  ): Promise<BillingPlan> {
    const existing = await transaction.billingPlan.findUnique({
      where: { shopifyPlanHandle: catalogue.shopifyPlanHandle },
    });
    if (existing) {
      if (!existing.active || existing.kind !== BillingPlanKind.FREE) {
        throw new FreePlanConfigurationUnavailableError();
      }
      await markCatalogueMaterialized(transaction, catalogue);
      return existing;
    }

    if (!(await isValidMaterializationConfiguration(transaction, catalogue))) {
      throw new FreePlanConfigurationUnavailableError();
    }
    try {
      const plan = await transaction.billingPlan.create({
        data: {
          shopifyPlanHandle: catalogue.shopifyPlanHandle,
          name: catalogue.displayName,
          kind: BillingPlanKind.FREE,
          active: true,
          shopifyUsageEventHandle: null,
          includedRecoveryConversationAllowance: null,
          recoveryCreditPackEnabled: false,
          recoveryCreditsPerPack: null,
          shopifyRecoveryCreditPackEventHandle: null,
          features: {
            create: catalogue.features.map((mapping) => ({
              featureId: mapping.featureId,
              enabled: true,
              configuration: mapping.configuration === null
                ? Prisma.JsonNull
                : mapping.configuration as Prisma.InputJsonValue,
            })),
          },
        },
      });
      await markCatalogueMaterialized(transaction, catalogue);
      return plan;
    } catch (error) {
      if (isPrismaCode(error, "P2002")) throw new RetryFreeActivationTransactionError();
      throw error;
    }
  }
}

function isEmptyInitialSubscription(subscription: {
  status: string;
  planId: string | null;
  observedShopifyPlanHandle: string | null;
  billingPeriodId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  providerSubscriptionId: string | null;
  lastSyncedAt: Date | null;
  lastSyncErrorCode: string | null;
  lastSyncErrorAt: Date | null;
  pendingShopifyPlanHandle: string | null;
  pendingPlanId: string | null;
  pendingEffectiveAt: Date | null;
  nextReconcileAt: Date | null;
  lastProviderLifecycleState: string | null;
  lastProviderLifecycleEventId: string | null;
  lastProviderLifecycleEventAt: Date | null;
}): boolean {
  return subscription.status === SubscriptionProjectionStatus.NO_CONTRACT &&
    subscription.planId === null &&
    subscription.observedShopifyPlanHandle === null &&
    subscription.billingPeriodId === null &&
    subscription.currentPeriodStart === null &&
    subscription.currentPeriodEnd === null &&
    subscription.trialEndsAt === null &&
    subscription.cancelAtPeriodEnd === false &&
    subscription.providerSubscriptionId === null &&
    subscription.lastSyncedAt === null &&
    subscription.lastSyncErrorCode === null &&
    subscription.lastSyncErrorAt === null &&
    subscription.pendingShopifyPlanHandle === null &&
    subscription.pendingPlanId === null &&
    subscription.pendingEffectiveAt === null &&
    subscription.nextReconcileAt === null &&
    subscription.lastProviderLifecycleState === null &&
    subscription.lastProviderLifecycleEventId === null &&
    subscription.lastProviderLifecycleEventAt === null;
}

function isValidFreeCataloguePlan(catalogue: FreeCataloguePlan): boolean {
  return catalogue.planKind === MerchantPricingPlanKind.FREE &&
    catalogue.isActive &&
    catalogue.allowancePeriod === MerchantPricingAllowancePeriod.LIFETIME &&
    catalogue.recurringAmountMinor === 0 &&
    catalogue.shopifyRecoveryUsageEventHandle === null &&
    Number.isSafeInteger(catalogue.includedRecoveryCredits) &&
    catalogue.includedRecoveryCredits >= 0;
}

async function isValidMaterializationConfiguration(
  transaction: Prisma.TransactionClient,
  catalogue: FreeCataloguePlan,
): Promise<boolean> {
  if (
    !catalogue.features.some((mapping) =>
      mapping.feature?.key === "checkout_recovery" && mapping.feature.systemRequired,
    ) ||
    catalogue.features.some((mapping) => !mapping.feature)
  ) {
    return false;
  }

  const merchantKnowledgeMappings = catalogue.features.filter((mapping) =>
    mapping.feature?.key === "merchant_knowledge",
  );
  if (merchantKnowledgeMappings.length === 0) return true;
  if (merchantKnowledgeMappings.length !== 1) return false;
  const configuration = MerchantKnowledgeFeatureConfigurationSchema.safeParse(
    merchantKnowledgeMappings[0]?.configuration,
  );
  if (!configuration.success) return false;

  const activeRows = await transaction.merchantKnowledgePurposeDataFormat.findMany({
    where: {
      purpose: { is: { active: true } },
      dataFormat: { is: { active: true } },
    },
    select: {
      purpose: { select: { key: true } },
      dataFormat: { select: { key: true } },
    },
  });
  const activePairs = new Set(activeRows.map((row) => `${row.purpose.key}\u0000${row.dataFormat.key}`));
  return configuration.data.allowedSourceTypes.every((sourceType) =>
    activePairs.has(`${sourceType.purposeKey}\u0000${sourceType.dataFormatKey}`),
  );
}

async function markCatalogueMaterialized(
  transaction: Prisma.TransactionClient,
  catalogue: FreeCataloguePlan,
): Promise<void> {
  if (catalogue.materializedAt === null) {
    await transaction.merchantPricingPlan.updateMany({
      where: { shopifyPlanHandle: catalogue.shopifyPlanHandle, materializedAt: null },
      data: { materializedAt: new Date() },
    });
  }
}

function freeSubscriptionProjection(planId: string) {
  return {
    planId,
    status: SubscriptionProjectionStatus.ACTIVE,
    observedShopifyPlanHandle: null,
    billingPeriodId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: null,
    lastSyncedAt: null,
    lastSyncErrorCode: null,
    lastSyncErrorAt: null,
    pendingShopifyPlanHandle: null,
    pendingPlanId: null,
    pendingEffectiveAt: null,
    nextReconcileAt: null,
    lastProviderLifecycleState: null,
    lastProviderLifecycleEventId: null,
    lastProviderLifecycleEventAt: null,
  };
}

function isPrismaCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}