import { PromotionCampaignStatus, PromotionTargetScope } from "@prisma/client";
import { BillingPresentationError, type CapacityBalance, type PaidIncludedBalance, type PurchasedBalance } from "./billing-presentation.contract.js";

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function projectBalance(
  counter: { grantedQuantity: number; committedQuantity: number; reservedQuantity: number; refundingQuantity: number } | undefined,
): CapacityBalance;
export function projectBalance(
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

export function projectPurchasedBalance(
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

export function projectPaidIncluded(
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

export function projectPromotion(
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
