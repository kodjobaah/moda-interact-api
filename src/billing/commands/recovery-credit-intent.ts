import {
  BillingOperationKind,
  BillingOperationState,
  BillingPlanKind,
  MerchantPricingPlanKind,
  MerchantPricingUsagePricingMode,
  Prisma,
  SubscriptionProjectionStatus,
  type BillingOperation,
  type PrismaClient,
} from "@prisma/client";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { RecoveryCreditPurchaseCommandError } from "./recovery-credit-command-error.js";
import { recoveryCreditPurchaseFingerprint } from "./recurring-command-primitives.js";

type BillingDatabase = Pick<PrismaClient, "$transaction">;

export interface RecoveryCreditCommandIntent {
  operation: BillingOperation;
  canonicalSiteUrl: string;
  bundleLabel: string;
  replay: boolean;
}

// The entire shop/subscription-locked intent runs inside one transaction.
// No provider requests, charge outcomes or credit grants occur here.
export class RecoveryCreditIntentPersistence {
  constructor(private readonly database: BillingDatabase) {}

  async persistIntent(
    principal: WooInstallationPrincipal,
    requestKey: string,
    merchantPricingUsageEventId: string,
  ): Promise<RecoveryCreditCommandIntent> {
    try {
      return await this.database.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
        `);
        const shop = await transaction.shop.findUnique({
          where: { id: principal.shopId },
          select: {
            id: true,
            domain: true,
            platform: true,
            shopifyShopId: true,
            status: true,
            onboardingCompleted: true,
          },
        });
        if (
          !shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
          shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE"
        ) throw new RecoveryCreditPurchaseCommandError(409, "billing_shop_invalid");
        if (!shop.onboardingCompleted) {
          throw new RecoveryCreditPurchaseCommandError(409, "billing_not_initialized");
        }

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
            providerSubscriptionId: true,
            cancelAtPeriodEnd: true,
            plan: { select: { id: true, kind: true, shopifyPlanHandle: true, active: true } },
            billingPeriod: {
              select: { id: true, shopId: true, subscriptionId: true, planId: true, status: true },
            },
          },
        });

        const existing = await transaction.billingOperation.findUnique({
          where: { shopId_requestKey: { shopId: shop.id, requestKey } },
        });
        if (existing) {
          const replayBundle = await transaction.merchantPricingUsageEvent.findUnique({
            where: { id: merchantPricingUsageEventId },
            select: { id: true, fixedUnitAmountMinor: true, currency: true },
          });
          return replayIntent(existing, merchantPricingUsageEventId, shop.domain, replayBundle);
        }

        if (
          !subscription || subscription.shopId !== shop.id || !subscription.planId ||
          !subscription.plan || subscription.planId !== subscription.plan.id ||
          subscription.status !== SubscriptionProjectionStatus.ACTIVE || !subscription.plan.active
        ) throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_unavailable");

        const currentCataloguePlan = await transaction.merchantPricingPlan.findUnique({
          where: { shopifyPlanHandle: subscription.plan.shopifyPlanHandle },
          select: { id: true, planKind: true, isActive: true, currency: true },
        });
        if (
          !currentCataloguePlan || !currentCataloguePlan.isActive ||
          !cataloguePlanKindMatches(subscription.plan.kind, currentCataloguePlan.planKind)
        ) throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_unavailable");

        const bundle = await transaction.merchantPricingUsageEvent.findUnique({
          where: { id: merchantPricingUsageEventId },
          select: {
            id: true,
            merchantPricingPlanId: true,
            adminLabel: true,
            creditsGrantedPerUnit: true,
            pricingMode: true,
            fixedUnitAmountMinor: true,
            currency: true,
          },
        });
        if (!bundle || bundle.merchantPricingPlanId !== currentCataloguePlan.id) {
          throw new RecoveryCreditPurchaseCommandError(404, "top_up_bundle_not_found");
        }
        if (
          bundle.pricingMode !== MerchantPricingUsagePricingMode.FIXED ||
          !isPositiveSafeInteger(bundle.fixedUnitAmountMinor) ||
          !isPositiveSafeInteger(bundle.creditsGrantedPerUnit) ||
          bundle.currency !== currentCataloguePlan.currency || bundle.currency !== "USD" ||
          typeof bundle.adminLabel !== "string" || bundle.adminLabel.trim().length === 0
        ) throw new RecoveryCreditPurchaseCommandError(409, "top_up_bundle_unavailable");

        let purchaseBillingPeriodId: string | null = null;
        let providerSubscriptionIdSnapshot: string | null = null;
        if (subscription.plan.kind === BillingPlanKind.FREE) {
          if (subscription.billingPeriodId !== null || subscription.providerSubscriptionId !== null) {
            throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_unavailable");
          }
        } else if (subscription.plan.kind === BillingPlanKind.PAID_METERED) {
          const providerReference = nonBlank(subscription.providerSubscriptionId);
          const period = subscription.billingPeriod;
          if (
            !providerReference || !subscription.billingPeriodId || !period ||
            period.id !== subscription.billingPeriodId || period.shopId !== shop.id ||
            period.subscriptionId !== subscription.id || period.planId !== subscription.plan.id ||
            period.status !== "OPEN"
          ) throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_unavailable");
          purchaseBillingPeriodId = period.id;
          providerSubscriptionIdSnapshot = providerReference;
        } else {
          throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_unavailable");
        }

        const pending = await transaction.billingOperation.findFirst({
          where: {
            shopId: shop.id,
            kind: BillingOperationKind.ONE_TIME_CHARGE,
            merchantPricingUsageEventId: bundle.id,
            state: {
              in: [
                BillingOperationState.INITIATING,
                BillingOperationState.AWAITING_CONFIRMATION,
                BillingOperationState.OUTCOME_UNKNOWN,
                BillingOperationState.CONFIRMED,
              ],
            },
            recoveryCreditPurchase: { is: { provider: "WOOCOMMERCE", status: "REQUESTED" } },
          },
          select: { id: true },
        });
        if (pending) throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_pending");

        const fingerprint = recoveryCreditPurchaseFingerprint({
          shopId: shop.id,
          merchantPricingUsageEventId: bundle.id,
          quotedAmountMinor: bundle.fixedUnitAmountMinor,
          quotedCurrency: bundle.currency,
        });
        const purchaseId = randomUUID();
        const purchase = await transaction.recoveryCreditPurchase.create({
          data: {
            id: purchaseId,
            shopId: shop.id,
            planId: subscription.plan.id,
            billingPeriodId: purchaseBillingPeriodId,
            shopifyPlanHandleSnapshot: null,
            shopifyEventHandleSnapshot: null,
            provider: "WOOCOMMERCE",
            providerReference: null,
            providerSubscriptionIdSnapshot,
            providerUsageQuantityBeforeSnapshot: null,
            providerUsageCostBeforeSnapshot: null,
            providerUsageCostCurrencyBeforeSnapshot: null,
            providerUsageQuantityAfterSnapshot: null,
            providerUsageCostAfterSnapshot: null,
            providerUsageCostCurrencyAfterSnapshot: null,
            providerPurchaseAmount: null,
            providerPurchaseCurrency: null,
            providerValuationConfirmedAt: null,
            providerPriceSnapshot: Prisma.DbNull,
            creditsGranted: bundle.creditsGrantedPerUnit,
            currentAmount: 0,
            reservedAmount: 0,
            status: "REQUESTED",
            usageEventId: null,
          },
        });
        const operation = await transaction.billingOperation.create({
          data: {
            shopId: shop.id,
            kind: BillingOperationKind.ONE_TIME_CHARGE,
            state: BillingOperationState.INITIATING,
            requestKey,
            requestFingerprint: new Uint8Array(fingerprint),
            merchantPricingPlanId: null,
            merchantPricingUsageEventId: bundle.id,
            quotedAmountMinor: bundle.fixedUnitAmountMinor,
            quotedCurrency: bundle.currency,
            quotedBillingPeriod: null,
            recoveryCreditPurchaseId: purchase.id,
            providerReference: null,
            confirmationUrl: null,
            lastErrorCode: null,
          },
        });
        return { operation, canonicalSiteUrl: shop.domain, bundleLabel: bundle.adminLabel.trim(), replay: false };
      }, { isolationLevel: "ReadCommitted" });
    } catch (error) {
      if (error instanceof RecoveryCreditPurchaseCommandError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new RecoveryCreditPurchaseCommandError(409, "billing_operation_conflict");
      }
      throw error;
    }
  }

}

function replayIntent(
  operation: BillingOperation,
  merchantPricingUsageEventId: string,
  canonicalSiteUrl: string,
  bundle: { id: string; fixedUnitAmountMinor: number | null; currency: string } | null,
): RecoveryCreditCommandIntent {
  if (
    operation.kind !== BillingOperationKind.ONE_TIME_CHARGE ||
    operation.merchantPricingUsageEventId !== merchantPricingUsageEventId ||
    !operation.recoveryCreditPurchaseId ||
    !bundle || bundle.id !== merchantPricingUsageEventId ||
    !isPositiveSafeInteger(bundle.fixedUnitAmountMinor) ||
    !bundle.currency
  ) throw new RecoveryCreditPurchaseCommandError(409, "idempotency_conflict", operation.id);
  const fingerprint = recoveryCreditPurchaseFingerprint({
    shopId: operation.shopId,
    merchantPricingUsageEventId,
    quotedAmountMinor: bundle.fixedUnitAmountMinor,
    quotedCurrency: bundle.currency,
  });
  const stored = Buffer.from(operation.requestFingerprint);
  if (stored.length !== fingerprint.length || !timingSafeEqual(stored, fingerprint)) {
    throw new RecoveryCreditPurchaseCommandError(409, "idempotency_conflict", operation.id);
  }
  return { operation, canonicalSiteUrl, bundleLabel: "", replay: true };
}


function cataloguePlanKindMatches(
  operationalKind: BillingPlanKind,
  catalogueKind: MerchantPricingPlanKind,
): boolean {
  return (operationalKind === BillingPlanKind.FREE && catalogueKind === MerchantPricingPlanKind.FREE) ||
    (operationalKind === BillingPlanKind.PAID_METERED && catalogueKind === MerchantPricingPlanKind.PAID_METERED);
}


function isPositiveSafeInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function nonBlank(value: string | null): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
