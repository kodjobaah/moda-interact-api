import {
  BillingOperationKind,
  BillingOperationState,
  BillingPlanKind,
  MerchantPricingAllowancePeriod,
  MerchantPricingBillingPeriod,
  MerchantPricingPlanKind,
  Prisma,
  SubscriptionProjectionStatus,
  type BillingOperation,
  type BillingPlan,
  type MerchantPricingPlan,
  type PrismaClient,
} from "@prisma/client";
import { timingSafeEqual } from "node:crypto";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import {
  FreePlanConfigurationUnavailableError,
  RetryFreeActivationTransactionError,
  type InitialWooFreeActivationService,
  type OperationalCataloguePlan,
} from "../../woocommerce/billing/initial-free-activation.service.js";
import { RecurringBillingCommandError } from "./recurring-command-error.js";
import {
  containsControlCharacters,
  recurringRequestFingerprint,
  type RecurringOperationKind,
} from "./recurring-command-primitives.js";

// Run the complete shop/subscription-locked intent in one ReadCommitted
// transaction. Provider calls and operation outcomes stay in the orchestrator.
type BillingDatabase = Pick<PrismaClient, "$transaction">;
export type MaterializedPlanResolver = Pick<InitialWooFreeActivationService, "resolvePaidPlan">;

interface LockedShop {
  id: string;
  domain: string;
  platform: string;
  shopifyShopId: string | null;
  status: string;
  onboardingCompleted: boolean;
}

export interface RecurringCommandIntent {
  operation: BillingOperation;
  canonicalSiteUrl: string;
  targetPlan: Pick<MerchantPricingPlan, "displayName"> | null;
  replay: boolean;
}

export class RecurringIntentPersistence {
  constructor(
    private readonly database: BillingDatabase,
    private readonly planResolver: MaterializedPlanResolver,
  ) {}

  async persistIntent(
    principal: WooInstallationPrincipal,
    kind: RecurringOperationKind,
    requestKey: string,
    merchantPricingPlanId?: string,
    materializationRetry = 0,
  ): Promise<RecurringCommandIntent> {
    try {
      return await this.database.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
        `);
        const shop = await transaction.shop.findUnique({
          where: { id: principal.shopId },
          select: { id: true, domain: true, platform: true, shopifyShopId: true, status: true, onboardingCompleted: true },
        }) as LockedShop | null;
        if (
          !shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
          shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE"
        ) throw new RecurringBillingCommandError(409, "billing_shop_invalid");
        if (!shop.onboardingCompleted) throw new RecurringBillingCommandError(409, "billing_not_initialized");

        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "billing"."Subscription" WHERE "shopId" = ${shop.id} FOR UPDATE
        `);
        const subscription = await transaction.subscription.findUnique({
          where: { shopId: shop.id },
          select: {
            id: true,
            shopId: true,
            planId: true,
            status: true,
            billingPeriodId: true,
            cancelAtPeriodEnd: true,
            providerSubscriptionId: true,
            plan: { select: { id: true, kind: true, shopifyPlanHandle: true, active: true } },
          },
        });

        const existing = await transaction.billingOperation.findUnique({
          where: { shopId_requestKey: { shopId: shop.id, requestKey } },
        });
        if (existing) {
          const replayCatalogue = kind === "CANCEL" || !merchantPricingPlanId
            ? null
            : await transaction.merchantPricingPlan.findUnique({ where: { id: merchantPricingPlanId } });
          return replayIntent(existing, kind, shop.domain, merchantPricingPlanId, replayCatalogue);
        }

        const operations = await transaction.billingOperation.findMany({
          where: {
            shopId: shop.id,
            kind: { in: [BillingOperationKind.SUBSCRIPTION_CREATE, BillingOperationKind.PLAN_SWITCH, BillingOperationKind.CANCEL] },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { kind: true, state: true, providerReference: true },
        });
        const hasUnresolvedOperation = operations.some((operation) =>
          operation.state === BillingOperationState.INITIATING ||
          operation.state === BillingOperationState.AWAITING_CONFIRMATION ||
          operation.state === BillingOperationState.OUTCOME_UNKNOWN,
        );
        const currentProviderReference = nonBlank(subscription?.providerSubscriptionId ?? null);
        const hasConfirmedCancellationForCurrentContract = operations.some((operation) =>
          operation.kind === BillingOperationKind.CANCEL && operation.state === BillingOperationState.CONFIRMED &&
          (subscription?.cancelAtPeriodEnd === true || !currentProviderReference ||
            operation.providerReference === currentProviderReference),
        );
        const canCreateAfterTerminalCancellation = kind === "SUBSCRIPTION_CREATE" &&
          subscription?.status === SubscriptionProjectionStatus.ACTIVE &&
          subscription?.plan?.kind === BillingPlanKind.FREE &&
          subscription.providerSubscriptionId === null &&
          subscription.billingPeriodId === null &&
          !subscription.cancelAtPeriodEnd;
        if (hasUnresolvedOperation ||
          (hasConfirmedCancellationForCurrentContract && !canCreateAfterTerminalCancellation)) {
          throw new RecurringBillingCommandError(409, "billing_operation_conflict");
        }
        if (!subscription?.plan || subscription.planId !== subscription.plan.id) {
          throw new RecurringBillingCommandError(409, "billing_subscription_invalid");
        }

        let target: MerchantPricingPlan | null = null;
        let targetOperationalPlan: BillingPlan | null = null;
        if (kind !== "CANCEL") {
          if (!merchantPricingPlanId) throw new RecurringBillingCommandError(400, "invalid_request");
          target = await transaction.merchantPricingPlan.findUnique({
            where: { id: merchantPricingPlanId },
            include: { features: { include: { feature: true } } },
          });
          if (target?.planKind === MerchantPricingPlanKind.FREE) {
            throw new RecurringBillingCommandError(409, "free_plan_uses_cancellation");
          }
          if (!target || !isSelectablePaidPlan(target)) {
            throw new RecurringBillingCommandError(409, "billing_plan_unavailable");
          }
        }

        const providerReference = nonBlank(subscription.providerSubscriptionId);
        if (kind === "SUBSCRIPTION_CREATE") {
          if (
            subscription.status !== SubscriptionProjectionStatus.ACTIVE || subscription.plan.kind !== BillingPlanKind.FREE ||
            subscription.providerSubscriptionId !== null || subscription.billingPeriodId !== null
          ) throw new RecurringBillingCommandError(409, "subscription_create_not_allowed");
        } else if (kind === "PLAN_SWITCH") {
          if (
            (subscription.status !== SubscriptionProjectionStatus.ACTIVE &&
              subscription.status !== SubscriptionProjectionStatus.TRIALING) ||
            subscription.plan.kind !== BillingPlanKind.PAID_METERED || !providerReference || subscription.cancelAtPeriodEnd
          ) throw new RecurringBillingCommandError(409, "subscription_switch_not_allowed");
          const currentCataloguePlan = await transaction.merchantPricingPlan.findUnique({
            where: { shopifyPlanHandle: subscription.plan.shopifyPlanHandle },
            select: { id: true },
          });
          if (!currentCataloguePlan) throw new RecurringBillingCommandError(409, "billing_catalogue_mapping_invalid");
          if (currentCataloguePlan.id === target!.id) throw new RecurringBillingCommandError(409, "billing_plan_unchanged");
        } else if (
          !providerReference || subscription.cancelAtPeriodEnd ||
          (subscription.status !== SubscriptionProjectionStatus.ACTIVE &&
            subscription.status !== SubscriptionProjectionStatus.TRIALING &&
            subscription.status !== SubscriptionProjectionStatus.FROZEN) ||
          subscription.plan.kind !== BillingPlanKind.PAID_METERED
        ) throw new RecurringBillingCommandError(409, "no_recurring_subscription");

        if (target) {
          targetOperationalPlan = await this.planResolver.resolvePaidPlan(transaction, target as OperationalCataloguePlan);
        }
        if (target && (!targetOperationalPlan || targetOperationalPlan.kind !== BillingPlanKind.PAID_METERED)) {
          throw new RecurringBillingCommandError(409, "billing_plan_materialization_invalid");
        }
        const fingerprint = recurringRequestFingerprint({
          kind,
          shopId: shop.id,
          ...(kind === "CANCEL" ? { providerReference: providerReference! } : {
            ...(kind === "PLAN_SWITCH" ? { providerReference: providerReference! } : {}),
            merchantPricingPlanId: target!.id,
            quotedAmountMinor: target!.recurringAmountMinor,
            quotedCurrency: target!.currency,
            quotedBillingPeriod: target!.billingPeriod,
          }),
        });
        const operation = await transaction.billingOperation.create({
          data: {
            shopId: shop.id,
            kind: operationKind(kind),
            state: BillingOperationState.INITIATING,
            requestKey,
            requestFingerprint: new Uint8Array(fingerprint),
            ...(target ? {
              merchantPricingPlanId: target.id,
              quotedAmountMinor: target.recurringAmountMinor,
              quotedCurrency: target.currency,
              quotedBillingPeriod: target.billingPeriod,
            } : {}),
            ...(kind !== "SUBSCRIPTION_CREATE" ? { providerReference: providerReference! } : {}),
          },
        });
        return { operation, canonicalSiteUrl: shop.domain, targetPlan: target, replay: false };
      }, { isolationLevel: "ReadCommitted" });
    } catch (error) {
      if (error instanceof RecurringBillingCommandError) throw error;
      if (error instanceof FreePlanConfigurationUnavailableError) {
        throw new RecurringBillingCommandError(409, "billing_plan_materialization_invalid");
      }
      if (error instanceof RetryFreeActivationTransactionError) {
        if (materializationRetry === 0) {
          return this.persistIntent(principal, kind, requestKey, merchantPricingPlanId, 1);
        }
        throw new RecurringBillingCommandError(409, "billing_plan_materialization_conflict");
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new RecurringBillingCommandError(409, "billing_operation_conflict");
      }
      throw error;
    }
  }
}

function replayIntent(
  operation: BillingOperation,
  kind: RecurringOperationKind,
  canonicalSiteUrl: string,
  merchantPricingPlanId?: string,
  catalogue?: MerchantPricingPlan | null,
): RecurringCommandIntent {
  if (
    operation.kind !== operationKind(kind) ||
    (kind !== "CANCEL" && operation.merchantPricingPlanId !== merchantPricingPlanId)
  ) throw new RecurringBillingCommandError(409, "idempotency_conflict", operation.id);
  if (kind !== "CANCEL" && (!catalogue || catalogue.id !== merchantPricingPlanId)) {
    throw new RecurringBillingCommandError(409, "idempotency_conflict", operation.id);
  }
  if (kind === "CANCEL" && !operation.providerReference) {
    throw new RecurringBillingCommandError(409, "idempotency_conflict", operation.id);
  }
  const fingerprint = recurringRequestFingerprint(kind === "CANCEL"
    ? { kind, shopId: operation.shopId, providerReference: operation.providerReference! }
    : {
        kind,
        shopId: operation.shopId,
        ...(kind === "PLAN_SWITCH" && operation.providerReference ? { providerReference: operation.providerReference } : {}),
        merchantPricingPlanId: catalogue!.id,
        quotedAmountMinor: catalogue!.recurringAmountMinor,
        quotedCurrency: catalogue!.currency,
        quotedBillingPeriod: catalogue!.billingPeriod,
      });
  const stored = Buffer.from(operation.requestFingerprint);
  if (stored.length !== fingerprint.length || !timingSafeEqual(stored, fingerprint)) {
    throw new RecurringBillingCommandError(409, "idempotency_conflict", operation.id);
  }
  return { operation, canonicalSiteUrl, targetPlan: null, replay: true };
}

function operationKind(kind: RecurringOperationKind): BillingOperationKind {
  return kind as BillingOperationKind;
}

function isSelectablePaidPlan(plan: MerchantPricingPlan): boolean {
  return plan.isActive && plan.planKind === MerchantPricingPlanKind.PAID_METERED &&
    plan.allowancePeriod === MerchantPricingAllowancePeriod.EVERY_30_DAYS &&
    plan.billingPeriod === MerchantPricingBillingPeriod.EVERY_30_DAYS &&
    Number.isSafeInteger(plan.recurringAmountMinor) && plan.recurringAmountMinor > 0 &&
    plan.currency === "USD" && Number.isSafeInteger(plan.includedRecoveryCredits) && plan.includedRecoveryCredits >= 0;
}

function nonBlank(value: string | null): string | null {
  return typeof value === "string" && value.trim().length > 0 && !containsControlCharacters(value) ? value : null;
}
