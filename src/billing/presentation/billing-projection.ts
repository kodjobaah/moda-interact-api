import {
  BillingOperationKind,
  BillingOperationState,
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  EntitlementCounter,
  MerchantPricingPlanKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import type { BillingSnapshotReader } from "./billing-snapshot.reader.js";
import { BillingPresentationError, type BillingPresentationResponse, type ExperienceState } from "./billing-presentation.contract.js";
import {
  isNonNegativeInteger, projectBalance, projectPaidIncluded, projectPromotion, projectPurchasedBalance,
} from "./billing-capacity.projection.js";
import { projectPurchase, projectTopUpOffers, projectUnresolvedPurchases } from "./billing-purchase.projection.js";

type Shop = NonNullable<Awaited<ReturnType<BillingSnapshotReader["readShop"]>>>;
type Core = Awaited<ReturnType<BillingSnapshotReader["readCore"]>>;
type Catalogue = Awaited<ReturnType<BillingSnapshotReader["readCurrentCataloguePlan"]>>;
type PendingPlan = Awaited<ReturnType<BillingSnapshotReader["readCataloguePlanById"]>>;
type ConfirmedCancellations = Awaited<ReturnType<BillingSnapshotReader["readConfirmedCancellation"]>>;

export interface BillingProjectionSnapshot {
  shop: Shop;
  core: Core;
  currentCataloguePlan: Catalogue;
  operationTargetPlan: PendingPlan;
  durablePendingCataloguePlan: PendingPlan;
  confirmedCancellation: ConfirmedCancellations | null;
  validPaidPeriod: boolean;
}

// Run these pure validation stages in the ORIGINAL order, between conditional
// queries. Moving the checks to the end would change which error wins and
// could cause a previously skipped catalogue/cancellation lookup to run.
export function validateShop(
  shop: Awaited<ReturnType<BillingSnapshotReader["readShop"]>>,
  principal: WooInstallationPrincipal,
): asserts shop is Shop {
  if (
    !shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
    shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE"
  ) throw new BillingPresentationError("billing_integrity_invalid");
  if (!shop.onboardingCompleted) throw new BillingPresentationError("billing_not_initialized");
}

export function validateCore(shop: Shop, { subscription, recurringOperations, requestedPurchases }: Core): void {
  if (recurringOperations.length > 1 || requestedPurchases.length > 100) {
    throw new BillingPresentationError("billing_operation_conflict");
  }
  if (subscription && (subscription.shopId !== shop.id || subscription.planId !== (subscription.plan?.id ?? null))) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }
}

export function validateCurrentCatalogue(subscription: Core["subscription"], currentCataloguePlan: Catalogue): void {
  if (subscription?.plan && (
    !currentCataloguePlan || currentCataloguePlan.shopifyPlanHandle !== subscription.plan.shopifyPlanHandle ||
    (subscription.plan.kind === BillingPlanKind.FREE) !== (currentCataloguePlan.planKind === MerchantPricingPlanKind.FREE) ||
    !isNonNegativeInteger(currentCataloguePlan.recurringAmountMinor) ||
    !/^[A-Z]{3}$/.test(currentCataloguePlan.currency) ||
    (currentCataloguePlan.planKind === MerchantPricingPlanKind.FREE && currentCataloguePlan.recurringAmountMinor !== 0)
  )) throw new BillingPresentationError("billing_catalogue_mapping_invalid");
  if ((currentCataloguePlan?.usageEvents.length ?? 0) > 100) {
    throw new BillingPresentationError("billing_catalogue_mapping_invalid");
  }
}

export function validatePendingPlans(
  subscription: Core["subscription"],
  recurringOperations: Core["recurringOperations"],
  operationTargetPlan: PendingPlan,
  durablePendingCataloguePlan: PendingPlan,
): void {
  const durablePendingPlan = subscription?.pendingPlanId ? subscription.pendingPlan : null;
  if (operationTargetPlan && durablePendingCataloguePlan && operationTargetPlan.id !== durablePendingCataloguePlan.id) {
    throw new BillingPresentationError("billing_operation_conflict");
  }
  if (recurringOperations[0]?.kind === BillingOperationKind.CANCEL && durablePendingPlan) {
    throw new BillingPresentationError("billing_operation_conflict");
  }
  if (durablePendingPlan && durablePendingPlan.id !== subscription?.pendingPlanId) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }
}

export function validateBillingPeriod(shop: Shop, subscription: Core["subscription"]): boolean {
  const paidPlan = subscription?.plan?.kind === BillingPlanKind.PAID_METERED;
  const paidPeriod = subscription?.billingPeriod;
  const periodCounter = paidPeriod?.entitlementCounters[0];
  const validPaidPeriod = Boolean(paidPlan && paidPeriod && periodCounter &&
    paidPeriod.id === subscription?.billingPeriodId && paidPeriod.shopId === shop.id &&
    paidPeriod.subscriptionId === subscription?.id && paidPeriod.planId === subscription?.planId &&
    paidPeriod.shopifyPlanHandleSnapshot === subscription?.plan?.shopifyPlanHandle &&
    paidPeriod.planKindSnapshot === BillingPlanKind.PAID_METERED &&
    paidPeriod.status === BillingPeriodStatus.OPEN && paidPeriod.periodStart < paidPeriod.periodEnd &&
    subscription?.currentPeriodStart?.getTime() === paidPeriod.periodStart.getTime() &&
    subscription?.currentPeriodEnd?.getTime() === paidPeriod.periodEnd.getTime() &&
    periodCounter.shopId === shop.id && periodCounter.billingPeriodId === paidPeriod.id &&
    periodCounter.counter === BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS &&
    isNonNegativeInteger(periodCounter.grantedQuantity) &&
    periodCounter.grantedQuantity === paidPeriod.includedRecoveryCreditsGranted &&
    (periodCounter.currentAllowanceQuantity === null || isNonNegativeInteger(periodCounter.currentAllowanceQuantity)) &&
    isNonNegativeInteger(periodCounter.committedQuantity) && isNonNegativeInteger(periodCounter.reservedQuantity) &&
    isNonNegativeInteger(periodCounter.forfeitedQuantity));
  if (paidPlan && subscription?.status !== SubscriptionProjectionStatus.NO_CONTRACT && !validPaidPeriod) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }
  if (subscription?.plan?.kind === BillingPlanKind.FREE &&
      (subscription.providerSubscriptionId !== null || subscription.billingPeriodId !== null ||
       subscription.currentPeriodStart !== null || subscription.currentPeriodEnd !== null)) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }
  return validPaidPeriod;
}

export function validateCancellations(
  subscription: Core["subscription"],
  recurringOperations: Core["recurringOperations"],
  pendingOperation: Core["recurringOperations"][number] | undefined,
  confirmedCancellation: ConfirmedCancellations | null,
): void {
  const paidPlan = subscription?.plan?.kind === BillingPlanKind.PAID_METERED;
  const pendingCancellationFromOperation = recurringOperations[0]?.kind === BillingOperationKind.CANCEL
    ? recurringOperations[0]
    : null;
  if (confirmedCancellation && confirmedCancellation.length > 1) {
    throw new BillingPresentationError("billing_operation_conflict");
  }
  if (confirmedCancellation && confirmedCancellation.length > 0 && (pendingOperation || pendingCancellationFromOperation)) {
    throw new BillingPresentationError("billing_operation_conflict");
  }
  if (pendingCancellationFromOperation && (!paidPlan || !subscription?.providerSubscriptionId)) {
    throw new BillingPresentationError("billing_operation_conflict");
  }
}

// Pure: all input rows were acquired inside the caller's RepeatableRead
// transaction, and the caller has performed the staged validation checks.
export function projectBillingPresentation(snapshot: BillingProjectionSnapshot, now: Date): BillingPresentationResponse {
  const { shop, core, currentCataloguePlan, operationTargetPlan, durablePendingCataloguePlan,
    confirmedCancellation, validPaidPeriod } = snapshot;
  const { subscription, counters, selection, recurringOperations, latestPurchase, requestedPurchases } = core;
  const paidPlan = subscription?.plan?.kind === BillingPlanKind.PAID_METERED;
  const paidPeriod = subscription?.billingPeriod;
  const periodCounter = paidPeriod?.entitlementCounters[0];
  const pendingOperation = recurringOperations.find((operation) =>
    operation.kind === BillingOperationKind.SUBSCRIPTION_CREATE || operation.kind === BillingOperationKind.PLAN_SWITCH,
  );
  const experienceState = resolveExperienceState(subscription?.status);
  const currentPlan = subscription && subscription.plan && currentCataloguePlan
    ? {
        merchantPricingPlanId: currentCataloguePlan.id,
        displayName: currentCataloguePlan.displayName,
        planKind: currentCataloguePlan.planKind,
        recurringAmountMinor: currentCataloguePlan.recurringAmountMinor,
        currency: currentCataloguePlan.currency,
        billingPeriod: currentCataloguePlan.billingPeriod,
        currentPeriodEnd: paidPlan && paidPeriod ? paidPeriod.periodEnd.toISOString() : null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        cancellationEffectiveAt: subscription.cancelAtPeriodEnd
          ? subscription.providerCoverageEndAt?.toISOString() ?? null
          : null,
      }
    : null;

  const currentRecurringOperation = recurringOperations[0];
  const pendingCancellationFromOperation = currentRecurringOperation?.kind === BillingOperationKind.CANCEL
    ? currentRecurringOperation
    : null;
  const pendingCancellation = pendingCancellationFromOperation
    ? subscription?.cancelAtPeriodEnd
      ? null
      : { state: unresolvedCancellationState(pendingCancellationFromOperation.state) }
    : confirmedCancellation?.[0] && subscription?.providerSubscriptionId &&
        confirmedCancellation[0].providerReference === subscription.providerSubscriptionId &&
        paidPlan && !subscription.cancelAtPeriodEnd
      ? { state: "CONFIRMED" as const }
      : null;

  const pendingPlanSource = operationTargetPlan ?? durablePendingCataloguePlan;
  const pendingPlan = pendingPlanSource
    ? {
        merchantPricingPlanId: pendingPlanSource.id,
        displayName: pendingPlanSource.displayName,
        recurringAmountMinor: pendingPlanSource.recurringAmountMinor,
        currency: pendingPlanSource.currency,
        billingPeriod: pendingPlanSource.billingPeriod,
        state: pendingOperation ? unresolvedCancellationState(pendingOperation.state) : "AWAITING_CONFIRMATION" as const,
      }
    : null;

  const counterMap = new Map(counters.map((counter) => [counter.counter, counter]));
  const lifetimeCounter = counterMap.get(EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS);
  const purchasedCounter = counterMap.get(EntitlementCounter.PURCHASED_RECOVERY_CREDITS);
  if (subscription?.plan?.kind === BillingPlanKind.FREE &&
      (subscription.status === SubscriptionProjectionStatus.ACTIVE || subscription.status === SubscriptionProjectionStatus.TRIALING) &&
      !lifetimeCounter) throw new BillingPresentationError("billing_integrity_invalid");
  if (lifetimeCounter && (lifetimeCounter.shopId !== shop.id ||
      lifetimeCounter.counter !== EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS)) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }
  const freeLifetime = projectBalance(lifetimeCounter);
  const purchased = projectPurchasedBalance(purchasedCounter);
  const promotional = projectPromotion(selection, subscription?.planId ?? null, shop.id, now);
  const paidIncluded = validPaidPeriod && periodCounter && subscription
    ? projectPaidIncluded(periodCounter, experienceState === "FROZEN" ||
        Boolean(subscription.providerSubscriptionId && subscription.providerCoverageEndAt && subscription.providerCoverageEndAt <= now))
    : null;

  const unresolvedPurchases = projectUnresolvedPurchases(requestedPurchases, shop.id);
  const latestPurchaseResponse = latestPurchase ? projectPurchase(latestPurchase) : null;
  const offers = projectTopUpOffers(currentCataloguePlan, unresolvedPurchases);
  const canPurchaseTopUps = experienceState === "ACTIVE" && offers.some((offer) => offer.purchaseEligible);
  const canManagePlans = experienceState === "ACTIVE" || experienceState === "NO_CONTRACT";
  const canCancel = Boolean(
    paidPlan && subscription?.providerSubscriptionId && !subscription.cancelAtPeriodEnd &&
    (experienceState === "ACTIVE" || experienceState === "FROZEN"),
  );

  return {
    schemaVersion: 1,
    experienceState,
    surfaces: {
      usageHistoryAllowed: true,
      purchaseHistoryAllowed: true,
      managePlansAllowed: canManagePlans && !subscription?.cancelAtPeriodEnd,
      cancelSubscriptionAllowed: canCancel,
    },
    currentPlan,
    pendingPlan,
    pendingCancellation,
    capacity: { paidIncluded, freeLifetime, promotional, purchased },
    topUps: {
      configured: offers.length > 0,
      purchaseEligible: canPurchaseTopUps,
      offers,
      latestPurchase: latestPurchaseResponse,
      unresolvedPurchases,
    },
  };
}

function resolveExperienceState(status: string | undefined): ExperienceState {
  if (status === SubscriptionProjectionStatus.ACTIVE || status === SubscriptionProjectionStatus.TRIALING) return "ACTIVE";
  if (status === SubscriptionProjectionStatus.NO_CONTRACT) return "NO_CONTRACT";
  if (status === SubscriptionProjectionStatus.FROZEN) return "FROZEN";
  return "BILLING_ATTENTION";
}

function unresolvedCancellationState(
  state: BillingOperationState,
): "INITIATING" | "AWAITING_CONFIRMATION" | "OUTCOME_UNKNOWN" {
  if (state === BillingOperationState.INITIATING || state === BillingOperationState.AWAITING_CONFIRMATION ||
      state === BillingOperationState.OUTCOME_UNKNOWN) return state;
  throw new BillingPresentationError("billing_integrity_invalid");
}
