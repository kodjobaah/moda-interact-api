import {
  BillingPlanKind,
  MerchantPricingAllowancePeriod,
  MerchantPricingPlanKind,
  Prisma,
  type BillingPlan,
  type MerchantPricingPlan,
  type PrismaClient,
} from "@prisma/client";
import { MerchantKnowledgeFeatureConfigurationSchema } from "@modainteract/moda-interact-shared/merchant-knowledge";
import { FreePlanConfigurationUnavailableError } from "./initial-free-activation.service.js";

// This preparation is a platform-global operation, not part of the Shop activation transaction.
export type FreePlanDatabase = Pick<PrismaClient,
  "merchantPricingPlan" | "billingPlan" | "merchantKnowledgePurposeDataFormat" | "platformBillingPolicy">;

export interface PreparedFreePlan {
  catalogueId: string;
  operationalPlanId: string;
  shopifyPlanHandle: string;
}

type FreeCataloguePlan = MerchantPricingPlan & {
  features: Array<{
    featureId: string;
    configuration: Prisma.JsonValue;
    feature: { key: string; systemRequired: boolean } | null;
  }>;
};

type FreeCatalogueInvariantFields = Pick<MerchantPricingPlan,
  "planKind" | "isActive" | "allowancePeriod" | "recurringAmountMinor" |
  "shopifyRecoveryUsageEventHandle" | "includedRecoveryCredits">;

export function isValidFreeCataloguePlan(catalogue: FreeCatalogueInvariantFields): boolean {
  return catalogue.planKind === MerchantPricingPlanKind.FREE &&
    catalogue.isActive &&
    catalogue.allowancePeriod === MerchantPricingAllowancePeriod.LIFETIME &&
    catalogue.recurringAmountMinor === 0 &&
    catalogue.shopifyRecoveryUsageEventHandle === null &&
    Number.isSafeInteger(catalogue.includedRecoveryCredits) &&
    catalogue.includedRecoveryCredits >= 0;
}

export function isValidLifetimeFreePolicy(policy: { lifetimeFreeRecoveryAllowance: number } | null): boolean {
  return Boolean(policy && Number.isSafeInteger(policy.lifetimeFreeRecoveryAllowance) &&
    policy.lifetimeFreeRecoveryAllowance >= 0);
}

export class WooFreePlanPreparationService {
  async prepare(database: FreePlanDatabase, requireFirstGrantPolicy: boolean): Promise<PreparedFreePlan> {
    const cataloguePlans = await database.merchantPricingPlan.findMany({
      where: { planKind: MerchantPricingPlanKind.FREE },
      include: { features: { include: { feature: true } } },
    });
    if (cataloguePlans.length !== 1) {
      throw new FreePlanConfigurationUnavailableError(
        cataloguePlans.length === 0 ? "free_catalogue_missing" : "multiple_free_catalogue_plans",
      );
    }
    const catalogue = cataloguePlans[0] as FreeCataloguePlan | undefined;
    if (!catalogue || !isValidFreeCataloguePlan(catalogue)) {
      throw new FreePlanConfigurationUnavailableError("free_catalogue_invalid");
    }

    // Fail before any global materialisation when a newly created Shop cannot receive its first grant.
    // Existing never-onboarded Shops may already have a lifetime counter, so their policy is
    // checked only inside the Shop transaction if a new counter is actually required.
    if (requireFirstGrantPolicy) {
      const policy = await database.platformBillingPolicy.findUnique({ where: { id: "default" } });
      if (!isValidLifetimeFreePolicy(policy)) {
        throw new FreePlanConfigurationUnavailableError("free_recovery_policy_invalid");
      }
    }

    const plan = await this.resolveOperationalPlan(database, catalogue);
    return {
      catalogueId: catalogue.id,
      operationalPlanId: plan.id,
      shopifyPlanHandle: catalogue.shopifyPlanHandle,
    };
  }

  private async resolveOperationalPlan(database: FreePlanDatabase, catalogue: FreeCataloguePlan): Promise<BillingPlan> {
    const existing = await database.billingPlan.findUnique({
      where: { shopifyPlanHandle: catalogue.shopifyPlanHandle },
    });
    if (existing) {
      ensureOperationalFreePlan(existing);
      await markCatalogueMaterialized(database, catalogue);
      return existing;
    }

    if (!(await isValidMaterializationConfiguration(database, catalogue))) {
      throw new FreePlanConfigurationUnavailableError("free_feature_configuration_invalid");
    }

    try {
      const created = await database.billingPlan.create({
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
      await markCatalogueMaterialized(database, catalogue);
      return created;
    } catch (error) {
      if (!isPrismaCode(error, "P2002")) throw error;
      // Another Shop may have materialised the single global plan concurrently.
      // Recover by reading the winner rather than restarting a Shop transaction.
      const winner = await database.billingPlan.findUnique({
        where: { shopifyPlanHandle: catalogue.shopifyPlanHandle },
      });
      if (!winner) throw new FreePlanConfigurationUnavailableError("activation_retry_exhausted");
      ensureOperationalFreePlan(winner);
      await markCatalogueMaterialized(database, catalogue);
      return winner;
    }
  }
}

function ensureOperationalFreePlan(plan: BillingPlan): void {
  if (!plan.active || plan.kind !== BillingPlanKind.FREE) {
    throw new FreePlanConfigurationUnavailableError("operational_free_plan_invalid");
  }
}

async function isValidMaterializationConfiguration(
  database: FreePlanDatabase,
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
  const knowledge = catalogue.features.filter((mapping) => mapping.feature?.key === "merchant_knowledge");
  if (knowledge.length === 0) return true;
  if (knowledge.length !== 1) return false;
  const configuration = MerchantKnowledgeFeatureConfigurationSchema.safeParse(knowledge[0]?.configuration);
  if (!configuration.success) return false;

  const activeRows = await database.merchantKnowledgePurposeDataFormat.findMany({
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

async function markCatalogueMaterialized(database: FreePlanDatabase, catalogue: FreeCataloguePlan): Promise<void> {
  if (catalogue.materializedAt === null) {
    await database.merchantPricingPlan.updateMany({
      where: { shopifyPlanHandle: catalogue.shopifyPlanHandle, materializedAt: null },
      data: { materializedAt: new Date() },
    });
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
