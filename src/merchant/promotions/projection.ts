import type {
  PromotionHistoryEntry, PromotionHistoryStatus, PromotionOffer, PromotionSelection,
} from "./contract.js";
import { PromotionDomainError } from "./contract.js";
import type { StoredPromotionSelection } from "./context.js";

export interface PromotionCampaignScope {
  scope: string;
  targetPlanId: string | null;
  targetShopId: string | null;
}

export function isPromotionTargetEligible(
  campaign: PromotionCampaignScope, shopId: string, planId: string,
): boolean {
  return (campaign.scope === "GLOBAL" && campaign.targetShopId === null && campaign.targetPlanId === null) ||
    (campaign.scope === "PLAN" && campaign.targetPlanId === planId && campaign.targetShopId === null) ||
    (campaign.scope === "SHOP" && campaign.targetShopId === shopId && campaign.targetPlanId === null);
}

export interface CreditBalance {
  quantity: number;
  reservedQuantity: number;
  committedQuantity: number;
  exhaustedAt: Date | null;
}

/** Corrupt balances are not silently advertised as spendable credits. */
export function remainingPromotionCredits(grant: CreditBalance): number {
  if (![grant.quantity, grant.reservedQuantity, grant.committedQuantity].every((value) =>
    Number.isSafeInteger(value) && value >= 0) ||
    grant.reservedQuantity + grant.committedQuantity > grant.quantity) {
    throw new PromotionDomainError(409, "promotion_integrity_invalid");
  }
  return grant.quantity - grant.reservedQuantity - grant.committedQuantity;
}

export function translatedPromotion(
  translations: Array<{ locale: string; merchantTitle: string; merchantDescription?: string }>,
  locale: string,
): { merchantTitle: string; merchantDescription?: string } | undefined {
  return translations.find((translation) => translation.locale === locale) ??
    translations.find((translation) => translation.locale === "en");
}

export function selectedPromotion(
  selection: StoredPromotionSelection | null, shopId: string, planId: string, locale: string, now: Date,
): PromotionSelection | null {
  if (!selection) return null;
  const grant = selection.promotionalCreditGrant;
  const campaign = grant.campaign;
  if (grant.shopId !== shopId || grant.id !== selection.promotionalCreditGrantId) {
    throw new PromotionDomainError(409, "promotion_integrity_invalid");
  }
  const remaining = remainingPromotionCredits(grant);
  const targetEligible = isPromotionTargetEligible(campaign, shopId, planId);
  const exhausted = Boolean(grant.exhaustedAt) || remaining === 0;
  return {
    campaignId: campaign.id,
    merchantTitle: (translatedPromotion(campaign.translations, locale)?.merchantTitle ?? campaign.name).slice(0, 255),
    quantityGranted: grant.quantity,
    committedQuantity: grant.committedQuantity,
    reservedQuantity: grant.reservedQuantity,
    remainingQuantity: remaining,
    expiresAt: campaign.expiresAt.toISOString(),
    locked: campaign.expiresAt > now,
    exhausted,
    campaignStatus: campaign.status,
    targetEligible,
    spendable: campaign.status === "ACTIVE" && campaign.startsAt <= now && campaign.expiresAt > now &&
      targetEligible && !exhausted,
  };
}

export function promotionOffer(
  campaign: {
    id: string; name: string; merchantDescription: string | null; quantity: number; expiresAt: Date;
    translations: Array<{ locale: string; merchantTitle: string; merchantDescription: string }>;
    promotionalCreditGrants: CreditBalance[];
  }, selectedCampaignId: string | null, locale: string, selectionLocked: boolean,
): PromotionOffer {
  const grant = campaign.promotionalCreditGrants[0];
  const remaining = grant ? remainingPromotionCredits(grant) : campaign.quantity;
  if (!Number.isSafeInteger(campaign.quantity) || campaign.quantity < 0 || remaining > campaign.quantity) {
    throw new PromotionDomainError(409, "promotion_integrity_invalid");
  }
  const exhausted = Boolean(grant?.exhaustedAt) || Boolean(grant && remaining === 0);
  const translation = translatedPromotion(campaign.translations, locale);
  return {
    id: campaign.id,
    merchantTitle: (translation?.merchantTitle ?? campaign.name).slice(0, 255),
    merchantDescription: (translation?.merchantDescription ?? campaign.merchantDescription ?? "").slice(0, 10000),
    quantity: campaign.quantity,
    expiresAt: campaign.expiresAt.toISOString(),
    remainingQuantity: remaining,
    previouslyClaimed: Boolean(grant),
    currentlySelected: selectedCampaignId === campaign.id,
    exhausted,
    eligible: true, // The query only returns live campaigns matching the authenticated shop/plan.
    selectable: !selectionLocked && !exhausted && campaign.quantity > 0,
  };
}

export function promotionHistoryStatus(
  grant: {
    firstSelectedAt: Date | null; firstUsedAt: Date | null; exhaustedAt: Date | null;
  },
  campaign: { status: string; expiresAt: Date } & PromotionCampaignScope,
  shopId: string, planId: string, reopenedAt: Date | null, remaining: number, now: Date,
): PromotionHistoryStatus {
  // Priority matches the existing Shopify promotion service.
  if (grant.exhaustedAt) return "EXHAUSTED";
  if (campaign.status === "CLOSED") return "CLOSED";
  if (campaign.expiresAt <= now) return "EXPIRED";
  if (!isPromotionTargetEligible(campaign, shopId, planId)) return "NO_LONGER_ELIGIBLE";
  if (reopenedAt && grant.firstSelectedAt && reopenedAt > grant.firstSelectedAt && remaining > 0) return "REOPENED";
  return grant.firstUsedAt ? "USED" : "SELECTED";
}

export function promotionHistoryEntry(
  grant: {
    quantity: number; reservedQuantity: number; committedQuantity: number;
    firstSelectedAt: Date | null; lastSelectedAt: Date | null; firstUsedAt: Date | null; exhaustedAt: Date | null;
    campaign: {
      id: string; name: string; status: string; expiresAt: Date;
      translations: Array<{ locale: string; merchantTitle: string }>;
      events: Array<{ createdAt: Date }>;
    } & PromotionCampaignScope;
  },
  shopId: string, planId: string, locale: string, now: Date,
): PromotionHistoryEntry {
  const remaining = remainingPromotionCredits(grant);
  return {
    campaignId: grant.campaign.id,
    campaignTitle: (translatedPromotion(grant.campaign.translations, locale)?.merchantTitle ?? grant.campaign.name).slice(0, 255),
    status: promotionHistoryStatus(grant, grant.campaign, shopId, planId,
      grant.campaign.events[0]?.createdAt ?? null, remaining, now),
    quantityGranted: grant.quantity,
    committedQuantity: grant.committedQuantity,
    remainingQuantity: remaining,
    lastSelectedAt: grant.lastSelectedAt?.toISOString() ?? null,
    expiresAt: grant.campaign.expiresAt.toISOString(),
  };
}
