import {
  BillingOperationKind,
  BillingOperationState,
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  EntitlementCounter,
  MerchantPricingPlanKind,
  PromotionCampaignStatus,
  PromotionTargetScope,
  SubscriptionProjectionStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";

export type BillingPresentationDatabase = Pick<PrismaClient, "$transaction">;

type ExperienceState = "ACTIVE" | "NO_CONTRACT" | "FROZEN" | "BILLING_ATTENTION";

interface CapacityBalance {
  granted: number;
  committed: number;
  reserved: number;
  remaining: number;
}

interface PaidIncludedBalance extends CapacityBalance {
  currentAllowance: number;
  forfeited: number;
}

interface PurchasedBalance {
  granted: number;
  committed: number;
  reserved: number;
  refunding: number;
  available: number;
}

interface PurchasePresentation {
  id: string;
  status: string;
  merchantPricingUsageEventId: string;
  label: string;
  creditsGranted: number;
  currentAmount: number;
  reservedAmount: number;
  createdAt: string;
  activatedAt: string | null;
  operationState: "INITIATING" | "AWAITING_CONFIRMATION" | "OUTCOME_UNKNOWN" | "CONFIRMED" | "FAILED";
}

export interface BillingPresentationResponse {
  schemaVersion: 1;
  experienceState: ExperienceState;
  surfaces: {
    usageHistoryAllowed: boolean;
    purchaseHistoryAllowed: boolean;
    managePlansAllowed: boolean;
    cancelSubscriptionAllowed: boolean;
  };
  currentPlan: null | {
    merchantPricingPlanId: string;
    displayName: string;
    planKind: "FREE" | "PAID_METERED";
    recurringAmountMinor: number;
    currency: string;
    billingPeriod: "EVERY_30_DAYS";
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    cancellationEffectiveAt: string | null;
  };
  pendingPlan: null | {
    merchantPricingPlanId: string;
    displayName: string;
    recurringAmountMinor: number;
    currency: string;
    billingPeriod: "EVERY_30_DAYS";
    state: "INITIATING" | "AWAITING_CONFIRMATION" | "OUTCOME_UNKNOWN";
  };
  pendingCancellation: null | {
    state: "INITIATING" | "AWAITING_CONFIRMATION" | "OUTCOME_UNKNOWN" | "CONFIRMED";
  };
  capacity: {
    paidIncluded: PaidIncludedBalance | null;
    freeLifetime: CapacityBalance;
    promotional: CapacityBalance;
    purchased: PurchasedBalance;
  };
  topUps: {
    configured: boolean;
    purchaseEligible: boolean;
    offers: Array<{
      merchantPricingUsageEventId: string;
      label: string;
      creditsGranted: number;
      amountMinor: number;
      currency: "USD";
      purchaseEligible: boolean;
      unavailableReason: "PENDING_PURCHASE" | null;
    }>;
    latestPurchase: PurchasePresentation | null;
    unresolvedPurchases: PurchasePresentation[];
  };
}

export class BillingPresentationError extends Error {
  constructor(readonly code:
    | "billing_not_initialized"
    | "billing_integrity_invalid"
    | "billing_catalogue_mapping_invalid"
    | "billing_operation_conflict"
  ) {
    super(code);
    this.name = "BillingPresentationError";
  }
}

export class BillingPresentationReadService {
  constructor(private readonly database: BillingPresentationDatabase) {}

  async read(principal: WooInstallationPrincipal, now = new Date()): Promise<BillingPresentationResponse> {
    return this.database.$transaction(
      (transaction) => readBillingSnapshot(transaction, principal, now),
      { isolationLevel: "RepeatableRead" },
    );
  }
}

async function readBillingSnapshot(
  transaction: Prisma.TransactionClient,
  principal: WooInstallationPrincipal,
  now: Date,
): Promise<BillingPresentationResponse> {
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
  ) throw new BillingPresentationError("billing_integrity_invalid");
  if (!shop.onboardingCompleted) throw new BillingPresentationError("billing_not_initialized");

  const [subscription, counters, selection, recurringOperations, latestPurchase, requestedPurchases] = await Promise.all([
    transaction.subscription.findUnique({
      where: { shopId: shop.id },
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
    transaction.shopEntitlementCounter.findMany({
      where: {
        shopId: shop.id,
        counter: { in: [EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS, EntitlementCounter.PURCHASED_RECOVERY_CREDITS] },
      },
      select: { shopId: true, counter: true, grantedQuantity: true, committedQuantity: true, reservedQuantity: true, refundingQuantity: true },
    }),
    transaction.merchantPromotionSelection.findUnique({
      where: { shopId: shop.id },
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
    transaction.billingOperation.findMany({
      where: {
        shopId: shop.id,
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
    transaction.recoveryCreditPurchase.findFirst({
      where: { shopId: shop.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: purchaseSelect,
    }),
    transaction.recoveryCreditPurchase.findMany({
      where: {
        shopId: shop.id,
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

  if (recurringOperations.length > 1 || requestedPurchases.length > 100) {
    throw new BillingPresentationError("billing_operation_conflict");
  }
  if (subscription && (subscription.shopId !== shop.id || subscription.planId !== (subscription.plan?.id ?? null))) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }

  const currentCataloguePlan = subscription?.plan
    ? await transaction.merchantPricingPlan.findUnique({
        where: { shopifyPlanHandle: subscription.plan.shopifyPlanHandle },
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
      })
    : null;
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

  const pendingOperation = recurringOperations.find((operation) =>
    operation.kind === BillingOperationKind.SUBSCRIPTION_CREATE || operation.kind === BillingOperationKind.PLAN_SWITCH,
  );
  const durablePendingPlan = subscription?.pendingPlanId ? subscription.pendingPlan : null;
  let operationTargetPlan: Awaited<ReturnType<typeof readCataloguePlanById>> = null;
  if (pendingOperation && !pendingOperation.merchantPricingPlanId) {
    throw new BillingPresentationError("billing_catalogue_mapping_invalid");
  }
  if (pendingOperation?.merchantPricingPlanId) {
    operationTargetPlan = await readCataloguePlanById(transaction, pendingOperation.merchantPricingPlanId);
    if (!operationTargetPlan) throw new BillingPresentationError("billing_catalogue_mapping_invalid");
  }
  let durablePendingCataloguePlan: Awaited<ReturnType<typeof readCataloguePlanByHandle>> = null;
  if (durablePendingPlan) {
    durablePendingCataloguePlan = await readCataloguePlanByHandle(transaction, durablePendingPlan.shopifyPlanHandle);
    if (!durablePendingCataloguePlan) throw new BillingPresentationError("billing_catalogue_mapping_invalid");
  }
  if (operationTargetPlan && durablePendingCataloguePlan && operationTargetPlan.id !== durablePendingCataloguePlan.id) {
    throw new BillingPresentationError("billing_operation_conflict");
  }
  if (recurringOperations[0]?.kind === BillingOperationKind.CANCEL && durablePendingPlan) {
    throw new BillingPresentationError("billing_operation_conflict");
  }
  if (durablePendingPlan && durablePendingPlan.id !== subscription?.pendingPlanId) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }

  const paidPlan = subscription?.plan?.kind === BillingPlanKind.PAID_METERED;
  const paidPeriod = subscription?.billingPeriod;
  const periodCounter = paidPeriod?.entitlementCounters[0];
  const validPaidPeriod = paidPlan && paidPeriod && periodCounter &&
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
    isNonNegativeInteger(periodCounter.forfeitedQuantity);
  if (paidPlan && subscription?.status !== SubscriptionProjectionStatus.NO_CONTRACT && !validPaidPeriod) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }
  if (subscription?.plan?.kind === BillingPlanKind.FREE &&
      (subscription.providerSubscriptionId !== null || subscription.billingPeriodId !== null ||
       subscription.currentPeriodStart !== null || subscription.currentPeriodEnd !== null)) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }

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
  let confirmedCancellation = null;
  if (
    subscription?.providerSubscriptionId && paidPlan && !subscription.cancelAtPeriodEnd
  ) {
    confirmedCancellation = await transaction.billingOperation.findMany({
      where: {
        shopId: shop.id,
        kind: BillingOperationKind.CANCEL,
        state: BillingOperationState.CONFIRMED,
        providerReference: subscription.providerSubscriptionId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
      select: { id: true, shopId: true, kind: true, state: true, providerReference: true },
    });
    if (confirmedCancellation.length > 1) throw new BillingPresentationError("billing_operation_conflict");
    if (confirmedCancellation.length > 0 && (pendingOperation || pendingCancellationFromOperation)) {
      throw new BillingPresentationError("billing_operation_conflict");
    }
  }
  if (pendingCancellationFromOperation && (!paidPlan || !subscription?.providerSubscriptionId)) {
    throw new BillingPresentationError("billing_operation_conflict");
  }
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

  const unresolvedPurchases = requestedPurchases.flatMap((purchase) => {
    const operation = purchase.billingOperation;
    if (!operation) throw new BillingPresentationError("billing_integrity_invalid");
    if (
      operation.shopId !== shop.id || operation.recoveryCreditPurchaseId !== purchase.id ||
      operation.kind !== BillingOperationKind.ONE_TIME_CHARGE
    ) throw new BillingPresentationError("billing_integrity_invalid");
    if (operation.state === BillingOperationState.FAILED) return [];
    if (![BillingOperationState.INITIATING, BillingOperationState.AWAITING_CONFIRMATION,
      BillingOperationState.OUTCOME_UNKNOWN, BillingOperationState.CONFIRMED].includes(operation.state)) {
      throw new BillingPresentationError("billing_integrity_invalid");
    }
    return [projectPurchase(purchase)];
  });
  const latestPurchaseResponse = latestPurchase ? projectPurchase(latestPurchase) : null;
  const pendingUsageEventIds = new Set(unresolvedPurchases.flatMap((purchase) =>
    purchase.merchantPricingUsageEventId ? [purchase.merchantPricingUsageEventId] : [],
  ));
  const offers = (currentCataloguePlan?.usageEvents ?? []).flatMap((event) => {
    if (
      event.pricingMode !== "FIXED" || !isPositiveInteger(event.fixedUnitAmountMinor) ||
      !isPositiveInteger(event.creditsGrantedPerUnit) || event.currency !== currentCataloguePlan?.currency ||
      event.currency !== "USD" || event.merchantPricingPlanId !== currentCataloguePlan.id
    ) return [];
    const pending = pendingUsageEventIds.has(event.id);
    const label = typeof event.adminLabel === "string" && event.adminLabel.trim()
      ? event.adminLabel.trim().slice(0, 120)
      : "Recovery credit bundle";
    return [{
      merchantPricingUsageEventId: event.id,
      label,
      creditsGranted: event.creditsGrantedPerUnit,
      amountMinor: event.fixedUnitAmountMinor,
      currency: "USD" as const,
      purchaseEligible: !pending,
      unavailableReason: pending ? "PENDING_PURCHASE" as const : null,
    }];
  });
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

async function readCataloguePlanById(transaction: Prisma.TransactionClient, id: string) {
  return transaction.merchantPricingPlan.findUnique({
    where: { id },
    select: { id: true, displayName: true, recurringAmountMinor: true, currency: true, billingPeriod: true },
  });
}

async function readCataloguePlanByHandle(transaction: Prisma.TransactionClient, shopifyPlanHandle: string) {
  return transaction.merchantPricingPlan.findUnique({
    where: { shopifyPlanHandle },
    select: { id: true, displayName: true, recurringAmountMinor: true, currency: true, billingPeriod: true },
  });
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function projectBalance(
  counter: { grantedQuantity: number; committedQuantity: number; reservedQuantity: number; refundingQuantity: number } | undefined,
): CapacityBalance;
function projectBalance(
  counter: { grantedQuantity: number; committedQuantity: number; reservedQuantity: number; refundingQuantity: number } | undefined,
): CapacityBalance {
  const granted = counter?.grantedQuantity ?? 0;
  const committed = counter?.committedQuantity ?? 0;
  const reserved = counter?.reservedQuantity ?? 0;
  const refunding = counter?.refundingQuantity ?? 0;
  if (![granted, committed, reserved, refunding].every(isNonNegativeInteger)) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }
  return { granted, committed, reserved, remaining: Math.max(granted - committed - reserved, 0) };
}

function projectPurchasedBalance(
  counter: { grantedQuantity: number; committedQuantity: number; reservedQuantity: number; refundingQuantity: number } | undefined,
): PurchasedBalance {
  const granted = counter?.grantedQuantity ?? 0;
  const committed = counter?.committedQuantity ?? 0;
  const reserved = counter?.reservedQuantity ?? 0;
  const refunding = counter?.refundingQuantity ?? 0;
  if (![granted, committed, reserved, refunding].every(isNonNegativeInteger)) {
    throw new BillingPresentationError("billing_integrity_invalid");
  }
  return {
    granted,
    committed,
    reserved,
    refunding,
    available: Math.max(granted - committed - reserved - refunding, 0),
  };
}

function projectPaidIncluded(
  counter: {
    grantedQuantity: number;
    currentAllowanceQuantity: number | null;
    committedQuantity: number;
    reservedQuantity: number;
    forfeitedQuantity: number;
  },
  frozen: boolean,
): PaidIncludedBalance {
  const currentAllowance = counter.currentAllowanceQuantity ?? counter.grantedQuantity;
  const quantities = [counter.grantedQuantity, currentAllowance, counter.committedQuantity, counter.reservedQuantity, counter.forfeitedQuantity];
  if (!quantities.every(isNonNegativeInteger)) throw new BillingPresentationError("billing_integrity_invalid");
  return {
    granted: counter.grantedQuantity,
    currentAllowance,
    committed: counter.committedQuantity,
    reserved: counter.reservedQuantity,
    forfeited: counter.forfeitedQuantity,
    remaining: frozen ? 0 : Math.max(currentAllowance - counter.committedQuantity - counter.reservedQuantity - counter.forfeitedQuantity, 0),
  };
}

function projectPromotion(
  selection: {
    shopId: string;
    promotionalCreditGrant: {
      shopId: string;
      quantity: number;
      committedQuantity: number;
      reservedQuantity: number;
      campaign: {
        scope: string;
        targetPlanId: string | null;
        targetShopId: string | null;
        startsAt: Date;
        expiresAt: Date;
        status: string;
      };
    };
  } | null,
  planId: string | null,
  shopId: string,
  now: Date,
): CapacityBalance {
  const grant = selection?.promotionalCreditGrant;
  const campaign = grant?.campaign;
  const matchesTarget = campaign && (
    (campaign.scope === PromotionTargetScope.GLOBAL && campaign.targetPlanId === null && campaign.targetShopId === null) ||
    (campaign.scope === PromotionTargetScope.PLAN && campaign.targetPlanId === planId && campaign.targetShopId === null) ||
    (campaign.scope === PromotionTargetScope.SHOP && campaign.targetShopId === shopId && campaign.targetPlanId === null)
  );
  if (
    !selection || !grant || !campaign || selection.shopId !== shopId || grant.shopId !== shopId ||
    !matchesTarget || campaign.status !== PromotionCampaignStatus.ACTIVE || campaign.startsAt > now ||
    campaign.expiresAt <= now || !isNonNegativeInteger(grant.quantity) ||
    !isNonNegativeInteger(grant.committedQuantity) || !isNonNegativeInteger(grant.reservedQuantity) ||
    grant.committedQuantity + grant.reservedQuantity > grant.quantity
  ) return { granted: 0, committed: 0, reserved: 0, remaining: 0 };
  return {
    granted: grant.quantity,
    committed: grant.committedQuantity,
    reserved: grant.reservedQuantity,
    remaining: Math.max(grant.quantity - grant.committedQuantity - grant.reservedQuantity, 0),
  };
}

function projectPurchase(purchase: {
  id: string;
  shopId: string;
  status: string;
  creditsGranted: number;
  currentAmount: number;
  reservedAmount: number;
  createdAt: Date;
  activatedAt: Date | null;
  billingOperation: {
    shopId: string;
    kind: string;
    state: string;
    recoveryCreditPurchaseId: string | null;
    merchantPricingUsageEventId: string | null;
    merchantPricingUsageEvent: { id: string; adminLabel: string; creditsGrantedPerUnit: number; merchantPricingPlanId: string } | null;
  } | null;
}): PurchasePresentation {
  const operation = purchase.billingOperation;
  if (
    !operation || operation.shopId !== purchase.shopId || operation.kind !== BillingOperationKind.ONE_TIME_CHARGE ||
    operation.recoveryCreditPurchaseId !== purchase.id ||
    !operation.merchantPricingUsageEventId ||
    operation.merchantPricingUsageEvent?.id !== operation.merchantPricingUsageEventId ||
    ![BillingOperationState.INITIATING, BillingOperationState.AWAITING_CONFIRMATION,
      BillingOperationState.OUTCOME_UNKNOWN, BillingOperationState.CONFIRMED, BillingOperationState.FAILED].includes(
      operation.state as BillingOperationState,
    ) ||
    ![purchase.creditsGranted, purchase.currentAmount, purchase.reservedAmount].every(isNonNegativeInteger)
  ) throw new BillingPresentationError("billing_integrity_invalid");
  const event = operation.merchantPricingUsageEvent;
  return {
    id: purchase.id,
    status: purchase.status,
    merchantPricingUsageEventId: operation.merchantPricingUsageEventId,
    label: event?.adminLabel.trim().slice(0, 120) || "Recovery credit bundle",
    creditsGranted: purchase.creditsGranted,
    currentAmount: purchase.currentAmount,
    reservedAmount: purchase.reservedAmount,
    createdAt: purchase.createdAt.toISOString(),
    activatedAt: purchase.activatedAt?.toISOString() ?? null,
    operationState: operation.state as PurchasePresentation["operationState"],
  };
}