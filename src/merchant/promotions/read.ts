import type { Prisma } from "@prisma/client";
import type { PromotionReadResponse, PromotionPagination } from "./contract.js";
import { PROMOTION_PAGE_SIZE } from "./contract.js";
import { readPromotionSelection, promotionRevision, type PromotionMerchantContext, type PromotionTransaction } from "./context.js";
import { promotionHistoryEntry, promotionOffer, selectedPromotion } from "./projection.js";

export interface PromotionReadOptions {
  offerPage: number;
  historyPage: number;
  locale: string;
}

function pagination(page: number, totalEntries: number): PromotionPagination {
  return {
    page: Math.min(page, Math.max(1, Math.ceil(totalEntries / PROMOTION_PAGE_SIZE))),
    pageSize: PROMOTION_PAGE_SIZE,
    totalEntries,
    totalPages: Math.max(1, Math.ceil(totalEntries / PROMOTION_PAGE_SIZE)),
  };
}

/** All four views come from one repeatable-read snapshot, with six DB rows per page. */
export async function readPromotions(
  tx: PromotionTransaction, context: PromotionMerchantContext,
  options: PromotionReadOptions, now: Date,
): Promise<PromotionReadResponse> {
  const shopId = context.shopId;
  const selected = await readPromotionSelection(tx, shopId, options.locale);
  const selectedState = selectedPromotion(selected, shopId, context.planId, options.locale, now);
  const offersWhere: Prisma.PromotionCampaignWhereInput = {
    status: "ACTIVE",
    startsAt: { lte: now },
    expiresAt: { gt: now },
    OR: [
      { scope: "GLOBAL", targetPlanId: null, targetShopId: null },
      { scope: "PLAN", targetPlanId: context.planId, targetShopId: null },
      { scope: "SHOP", targetShopId: shopId, targetPlanId: null },
    ],
  };
  const [offerCount, historyCount] = await Promise.all([
    tx.promotionCampaign.count({ where: offersWhere }),
    tx.promotionalCreditGrant.count({ where: { shopId } }),
  ]);
  const offersPagination = pagination(options.offerPage, offerCount);
  const historyPagination = pagination(options.historyPage, historyCount);
  const [campaigns, grants] = await Promise.all([
    tx.promotionCampaign.findMany({
      where: offersWhere,
      orderBy: [{ expiresAt: "asc" }, { createdAt: "desc" }, { id: "desc" }],
      skip: (offersPagination.page - 1) * PROMOTION_PAGE_SIZE,
      take: PROMOTION_PAGE_SIZE,
      select: {
        id: true, name: true, merchantDescription: true, quantity: true, expiresAt: true,
        translations: {
          where: { locale: { in: [options.locale, "en"] } },
          select: { locale: true, merchantTitle: true, merchantDescription: true },
        },
        promotionalCreditGrants: {
          where: { shopId }, take: 1,
          select: { quantity: true, reservedQuantity: true, committedQuantity: true, exhaustedAt: true },
        },
      },
    }),
    tx.promotionalCreditGrant.findMany({
      where: { shopId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (historyPagination.page - 1) * PROMOTION_PAGE_SIZE,
      take: PROMOTION_PAGE_SIZE,
      select: {
        quantity: true, reservedQuantity: true, committedQuantity: true,
        firstSelectedAt: true, lastSelectedAt: true, firstUsedAt: true, exhaustedAt: true,
        campaign: {
          select: {
            id: true, name: true, status: true, expiresAt: true, scope: true,
            targetPlanId: true, targetShopId: true,
            translations: {
              where: { locale: { in: [options.locale, "en"] } },
              select: { locale: true, merchantTitle: true },
            },
            events: {
              where: { kind: "REOPENED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 1, select: { createdAt: true },
            },
          },
        },
      },
    }),
  ]);
  return {
    schemaVersion: 1,
    revision: promotionRevision(context, selected),
    offers: campaigns.map((campaign) => promotionOffer(
      campaign, selected?.promotionalCreditGrant.campaign.id ?? null,
      options.locale, selectedState?.locked === true,
    )),
    offersPagination,
    selection: selectedState,
    history: {
      ...historyPagination,
      entries: grants.map((grant) => promotionHistoryEntry(grant, shopId, context.planId, options.locale, now)),
    },
  };
}
