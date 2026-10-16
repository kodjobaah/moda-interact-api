import {
  BillingOperationKind,
  BillingOperationState,
  BillingPeriodEntitlementCounterKind,
  EntitlementCounter,
  type Prisma,
} from "@prisma/client";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";

// API-internal, transaction-bound query collaborator. The caller retains shop
// validation, integrity precedence and response projection; API-003 owns the
// later projection extraction. All reads use the SAME transaction client.
export class BillingSnapshotReader {
  constructor(
    private readonly transaction: Prisma.TransactionClient,
    private readonly shopId: WooInstallationPrincipal["shopId"],
  ) {}

  readShop() {
    return this.transaction.shop.findUnique({
      where: { id: this.shopId },
      select: {
        id: true,
        domain: true,
        platform: true,
        shopifyShopId: true,
        status: true,
        onboardingCompleted: true,
      },
    });
  }

  async readCore() {
    const [subscription, counters, selection, recurringOperations, latestPurchase, requestedPurchases] = await Promise.all([
      this.transaction.subscription.findUnique({
        where: { shopId: this.shopId },
        select: {
          id: true,
          shopId: true,
          planId: true,
          status: true,
          billingPeriodId: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          providerSubscriptionId: true,
          providerCoverageEndAt: true,
          pendingPlanId: true,
          pendingEffectiveAt: true,
          plan: { select: { id: true, shopifyPlanHandle: true, kind: true, active: true } },
          pendingPlan: { select: { id: true, shopifyPlanHandle: true, kind: true, active: true } },
          billingPeriod: {
            select: {
              id: true,
              shopId: true,
              subscriptionId: true,
              planId: true,
              shopifyPlanHandleSnapshot: true,
              planKindSnapshot: true,
              includedRecoveryCreditsGranted: true,
              periodStart: true,
              periodEnd: true,
              status: true,
              entitlementCounters: {
                where: { counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS },
                select: {
                  shopId: true,
                  billingPeriodId: true,
                  counter: true,
                  grantedQuantity: true,
                  currentAllowanceQuantity: true,
                  committedQuantity: true,
                  reservedQuantity: true,
                  forfeitedQuantity: true,
                },
              },
            },
          },
        },
      }),
      this.transaction.shopEntitlementCounter.findMany({
        where: {
          shopId: this.shopId,
          counter: { in: [EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS, EntitlementCounter.PURCHASED_RECOVERY_CREDITS] },
        },
        select: { shopId: true, counter: true, grantedQuantity: true, committedQuantity: true, reservedQuantity: true, refundingQuantity: true },
      }),
      this.transaction.merchantPromotionSelection.findUnique({
        where: { shopId: this.shopId },
        select: {
          shopId: true,
          promotionalCreditGrant: {
            select: {
              id: true,
              shopId: true,
              quantity: true,
              committedQuantity: true,
              reservedQuantity: true,
              campaign: {
                select: {
                  id: true,
                  scope: true,
                  targetPlanId: true,
                  targetShopId: true,
                  startsAt: true,
                  expiresAt: true,
                  status: true,
                },
              },
            },
          },
        },
      }),
      this.transaction.billingOperation.findMany({
        where: {
          shopId: this.shopId,
          kind: { in: [BillingOperationKind.SUBSCRIPTION_CREATE, BillingOperationKind.PLAN_SWITCH, BillingOperationKind.CANCEL] },
          state: { in: [BillingOperationState.INITIATING, BillingOperationState.AWAITING_CONFIRMATION, BillingOperationState.OUTCOME_UNKNOWN] },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 3,
        select: {
          id: true,
          shopId: true,
          kind: true,
          state: true,
          merchantPricingPlanId: true,
          providerReference: true,
          createdAt: true,
        },
      }),
      this.transaction.recoveryCreditPurchase.findFirst({
        where: { shopId: this.shopId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: purchaseSelect,
      }),
      this.transaction.recoveryCreditPurchase.findMany({
        where: {
          shopId: this.shopId,
          status: "REQUESTED",
          OR: [
            { billingOperation: { is: { state: { in: [
              BillingOperationState.INITIATING,
              BillingOperationState.AWAITING_CONFIRMATION,
              BillingOperationState.OUTCOME_UNKNOWN,
              BillingOperationState.CONFIRMED,
            ] } } } },
            { billingOperation: { is: null } },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 101,
        select: purchaseSelect,
      }),
    ]);
    return { subscription, counters, selection, recurringOperations, latestPurchase, requestedPurchases };
  }

  // Catalogue lookups are conditional: the service performs their existing
  // validation before proceeding to the next query (preserving error precedence).
  readCurrentCataloguePlan(shopifyPlanHandle: string) {
    return this.transaction.merchantPricingPlan.findUnique({
      where: { shopifyPlanHandle },
      select: {
        id: true,
        shopifyPlanHandle: true,
        displayName: true,
        planKind: true,
        isActive: true,
        recurringAmountMinor: true,
        currency: true,
        billingPeriod: true,
        usageEvents: {
          orderBy: [{ position: "asc" }, { id: "asc" }],
          take: 101,
          select: {
            id: true,
            merchantPricingPlanId: true,
            adminLabel: true,
            creditsGrantedPerUnit: true,
            pricingMode: true,
            fixedUnitAmountMinor: true,
            currency: true,
            position: true,
          },
        },
      },
    });
  }

  readCataloguePlanById(id: string) {
    return this.transaction.merchantPricingPlan.findUnique({
      where: { id },
      select: { id: true, displayName: true, recurringAmountMinor: true, currency: true, billingPeriod: true },
    });
  }

  readCataloguePlanByHandle(shopifyPlanHandle: string) {
    return this.transaction.merchantPricingPlan.findUnique({
      where: { shopifyPlanHandle },
      select: { id: true, displayName: true, recurringAmountMinor: true, currency: true, billingPeriod: true },
    });
  }

  readConfirmedCancellation(providerReference: string) {
    return this.transaction.billingOperation.findMany({
      where: {
        shopId: this.shopId,
        kind: BillingOperationKind.CANCEL,
        state: BillingOperationState.CONFIRMED,
        providerReference,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
      select: { id: true, shopId: true, kind: true, state: true, providerReference: true },
    });
  }
}

// Retain the original select literal to keep top-up operation relations exact.
const purchaseSelect = {
  id: true,
  shopId: true,
  status: true,
  creditsGranted: true,
  currentAmount: true,
  reservedAmount: true,
  createdAt: true,
  activatedAt: true,
  billingOperation: {
    select: {
      shopId: true,
      kind: true,
      state: true,
      recoveryCreditPurchaseId: true,
      merchantPricingUsageEventId: true,
      merchantPricingUsageEvent: {
        select: { id: true, adminLabel: true, creditsGrantedPerUnit: true, merchantPricingPlanId: true },
      },
    },
  },
} satisfies Prisma.RecoveryCreditPurchaseSelect;
