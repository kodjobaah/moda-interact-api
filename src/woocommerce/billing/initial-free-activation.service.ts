import {
  MerchantPricingAllowancePeriod,
  BillingPlanKind,
  EntitlementCounter,
  MerchantPricingPlanKind,
  Prisma,
  SubscriptionProjectionStatus,
  type BillingPlan,
  type MerchantPricingPlan,
} from "@prisma/client";
import { MerchantKnowledgeFeatureConfigurationSchema } from "@modainteract/moda-interact-shared/merchant-knowledge";
import {
  isValidFreeCataloguePlan,
  isValidLifetimeFreePolicy,
  WooFreePlanPreparationService,
  type FreePlanDatabase,
  type PreparedFreePlan,
} from "./free-plan-preparation.service.js";

export type FreePlanConfigurationFailureReason =
  | "shop_missing"
  | "free_catalogue_missing"
  | "multiple_free_catalogue_plans"
  | "free_catalogue_invalid"
  | "operational_free_plan_invalid"
  | "free_feature_configuration_invalid"
  | "paid_catalogue_invalid"
  | "operational_paid_plan_invalid"
  | "paid_feature_configuration_invalid"
  | "free_recovery_policy_invalid"
  | "activation_retry_exhausted"
  | "unspecified";

export class FreePlanConfigurationUnavailableError extends Error {
  constructor(readonly reason: FreePlanConfigurationFailureReason = "unspecified") {
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

export type OperationalCataloguePlan = MerchantPricingPlan & {
  features: Array<{
    featureId: string;
    configuration: Prisma.JsonValue;
    feature: { key: string; systemRequired: boolean } | null;
  }>;
};

export class InitialWooFreeActivationService {
  private readonly preparation = new WooFreePlanPreparationService();

  prepare(database: FreePlanDatabase, requireFirstGrantPolicy: boolean): Promise<PreparedFreePlan> {
    return this.preparation.prepare(database, requireFirstGrantPolicy);
  }

  async activate(
    transaction: Prisma.TransactionClient,
    shopId: string,
    prepared: PreparedFreePlan | null,
  ): Promise<"ACTIVATED_FREE" | "ALREADY_ONBOARDED"> {
    const shop = await transaction.shop.findUnique({
      where: { id: shopId },
      select: { id: true, onboardingCompleted: true },
    });
    if (!shop) throw new FreePlanConfigurationUnavailableError("shop_missing");
    if (shop.onboardingCompleted) return "ALREADY_ONBOARDED";

    const subscription = await transaction.subscription.findUnique({ where: { shopId } });
    if (subscription && !isEmptyInitialSubscription(subscription)) {
      throw new InitialFreeActivationConflictError();
    }

    // Resolve and materialise global Free-plan configuration outside this Shop transaction.
    // Recheck its small, mutable invariants here to fail closed if Admin changed it
    // after preparation, without re-running feature/knowledge materialisation queries.
    if (!prepared) throw new FreePlanConfigurationUnavailableError("free_catalogue_missing");
    const cataloguePlans = await transaction.merchantPricingPlan.findMany({
      where: { planKind: MerchantPricingPlanKind.FREE },
      select: {
        id: true,
        shopifyPlanHandle: true,
        planKind: true,
        isActive: true,
        allowancePeriod: true,
        recurringAmountMinor: true,
        shopifyRecoveryUsageEventHandle: true,
        includedRecoveryCredits: true,
      },
    });
    const catalogue = cataloguePlans[0];
    if (cataloguePlans.length !== 1 || !catalogue || catalogue.id !== prepared.catalogueId ||
      catalogue.shopifyPlanHandle !== prepared.shopifyPlanHandle || !isValidFreeCataloguePlan(catalogue)) {
      throw new FreePlanConfigurationUnavailableError("free_catalogue_invalid");
    }
    const plan = await transaction.billingPlan.findUnique({
      where: { id: prepared.operationalPlanId },
      select: { id: true, active: true, kind: true, shopifyPlanHandle: true },
    });
    if (!plan || !plan.active || plan.kind !== BillingPlanKind.FREE ||
      plan.shopifyPlanHandle !== prepared.shopifyPlanHandle) {
      throw new FreePlanConfigurationUnavailableError("operational_free_plan_invalid");
    }

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
    if (!lifetimeCounter && !isValidLifetimeFreePolicy(policy)) {
      throw new FreePlanConfigurationUnavailableError("free_recovery_policy_invalid");
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
  async resolvePaidPlan(
    transaction: Prisma.TransactionClient,
    catalogue: OperationalCataloguePlan,
  ): Promise<BillingPlan> {
    if (
      catalogue.planKind !== MerchantPricingPlanKind.PAID_METERED || !catalogue.isActive ||
      catalogue.allowancePeriod !== MerchantPricingAllowancePeriod.EVERY_30_DAYS ||
      catalogue.billingPeriod !== "EVERY_30_DAYS" || !Number.isSafeInteger(catalogue.includedRecoveryCredits) ||
      catalogue.includedRecoveryCredits < 0 || !Number.isSafeInteger(catalogue.recurringAmountMinor) ||
      catalogue.recurringAmountMinor <= 0 || catalogue.currency !== "USD"
    ) throw new FreePlanConfigurationUnavailableError("paid_catalogue_invalid");
    return this.resolveOperationalPlan(transaction, catalogue, BillingPlanKind.PAID_METERED);
  }

  private async resolveOperationalPlan(
    transaction: Prisma.TransactionClient,
    catalogue: OperationalCataloguePlan,
    expectedKind: BillingPlanKind,
  ): Promise<BillingPlan> {
    const existing = await transaction.billingPlan.findUnique({
      where: { shopifyPlanHandle: catalogue.shopifyPlanHandle },
    });
    if (existing) {
      if (!existing.active || existing.kind !== expectedKind) {
        throw new FreePlanConfigurationUnavailableError(
          expectedKind === BillingPlanKind.FREE ? "operational_free_plan_invalid" : "operational_paid_plan_invalid",
        );
      }
      await markCatalogueMaterialized(transaction, catalogue);
      return existing;
    }

    if (!(await isValidMaterializationConfiguration(transaction, catalogue))) {
      throw new FreePlanConfigurationUnavailableError(
        expectedKind === BillingPlanKind.FREE ? "free_feature_configuration_invalid" : "paid_feature_configuration_invalid",
      );
    }
    try {
      const plan = await transaction.billingPlan.create({
        data: {
          shopifyPlanHandle: catalogue.shopifyPlanHandle,
          name: catalogue.displayName,
          kind: expectedKind,
          active: true,
          shopifyUsageEventHandle: expectedKind === BillingPlanKind.PAID_METERED
            ? catalogue.shopifyRecoveryUsageEventHandle
            : null,
          includedRecoveryConversationAllowance: expectedKind === BillingPlanKind.PAID_METERED
            ? catalogue.includedRecoveryCredits
            : null,
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
  providerCoverageEndAt: Date | null;
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
    subscription.providerCoverageEndAt === null &&
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

async function isValidMaterializationConfiguration(
  transaction: Prisma.TransactionClient,
  catalogue: OperationalCataloguePlan,
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
  catalogue: OperationalCataloguePlan,
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
    providerCoverageEndAt: null,
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