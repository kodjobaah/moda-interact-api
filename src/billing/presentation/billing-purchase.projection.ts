import { BillingOperationKind, BillingOperationState } from "@prisma/client";
import { BillingPresentationError, type BillingPresentationResponse, type PurchasePresentation } from "./billing-presentation.contract.js";
import { isNonNegativeInteger } from "./billing-capacity.projection.js";
import type { BillingSnapshotReader } from "./billing-snapshot.reader.js";

type BillingCore = Awaited<ReturnType<BillingSnapshotReader["readCore"]>>;
type Catalogue = Awaited<ReturnType<BillingSnapshotReader["readCurrentCataloguePlan"]>>;

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

// Keep unresolved-purchase ordering and integrity failures the same as the original read.
export function projectUnresolvedPurchases(purchases: BillingCore["requestedPurchases"], shopId: string): PurchasePresentation[] {
  return purchases.flatMap((purchase) => {
    const operation = purchase.billingOperation;
    if (!operation) throw new BillingPresentationError("billing_integrity_invalid");
    if (
      operation.shopId !== shopId || operation.recoveryCreditPurchaseId !== purchase.id ||
      operation.kind !== BillingOperationKind.ONE_TIME_CHARGE
    ) throw new BillingPresentationError("billing_integrity_invalid");
    if (operation.state === BillingOperationState.FAILED) return [];
    if (![BillingOperationState.INITIATING, BillingOperationState.AWAITING_CONFIRMATION,
      BillingOperationState.OUTCOME_UNKNOWN, BillingOperationState.CONFIRMED].includes(operation.state)) {
      throw new BillingPresentationError("billing_integrity_invalid");
    }
    return [projectPurchase(purchase)];
  });
}

export function projectTopUpOffers(
  currentCataloguePlan: Catalogue,
  unresolvedPurchases: PurchasePresentation[],
): BillingPresentationResponse["topUps"]["offers"] {
  const pendingUsageEventIds = new Set(unresolvedPurchases.flatMap((purchase) =>
    purchase.merchantPricingUsageEventId ? [purchase.merchantPricingUsageEventId] : [],
  ));
  return (currentCataloguePlan?.usageEvents ?? []).flatMap((event) => {
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
}

export function projectPurchase(purchase: NonNullable<BillingCore["latestPurchase"]>): PurchasePresentation {
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
