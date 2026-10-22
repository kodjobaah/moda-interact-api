import { Prisma } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import type { PromotionReadResponse, PromotionSelectionRequest, PromotionSelectionResponse } from "./contract.js";
import { PromotionDomainError } from "./contract.js";
import { promotionRevision, readPromotionSelection, requirePromotionMerchant, type PromotionDatabase } from "./context.js";
import { isPromotionTargetEligible, remainingPromotionCredits, selectedPromotion } from "./projection.js";
import { readPromotions, type PromotionReadOptions } from "./read.js";

/** Owns only merchant promotion selection, never grant consumption or credit allocation. */
export class MerchantPromotionsService {
  constructor(private readonly database: PromotionDatabase, private readonly now: () => Date = () => new Date()) {}

  read(principal: WooInstallationPrincipal, options: PromotionReadOptions): Promise<PromotionReadResponse> {
    return this.database.$transaction(async (tx) => {
      const context = await requirePromotionMerchant(tx, principal, false);
      return readPromotions(tx, context, options, this.now());
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async select(principal: WooInstallationPrincipal, request: PromotionSelectionRequest): Promise<PromotionSelectionResponse> {
    // Serializable retries never replay a stale revision as a new grant/selection.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.$transaction(async (tx) => {
          const context = await requirePromotionMerchant(tx, principal, true);
          const now = this.now();
          const current = await readPromotionSelection(tx, context.shopId, "en");
          const revision = promotionRevision(context, current);
          const currentCampaignId = current?.promotionalCreditGrant.campaign.id;
          // An identical retried PUT can succeed after its first commit, but never
          // writes or increments selectionCount a second time.
          const identicalActive = current !== null && currentCampaignId === request.campaignId &&
            current.promotionalCreditGrant.campaign.expiresAt > now;
          if (revision !== request.expectedRevision && !identicalActive) {
            throw new PromotionDomainError(409, "promotion_revision_conflict");
          }
          const campaign = await tx.promotionCampaign.findUnique({
            where: { id: request.campaignId },
            select: {
              id: true, quantity: true, scope: true, startsAt: true, expiresAt: true,
              status: true, targetPlanId: true, targetShopId: true,
            },
          });
          if (!campaign || campaign.status !== "ACTIVE" || campaign.startsAt > now ||
            campaign.expiresAt <= now || !isPromotionTargetEligible(campaign, context.shopId, context.planId)) {
            throw new PromotionDomainError(422, "promotion_not_eligible");
          }
          if (!Number.isSafeInteger(campaign.quantity) || campaign.quantity <= 0) {
            throw new PromotionDomainError(422, "promotion_exhausted");
          }
          if (identicalActive) {
            const selection = selectedPromotion(current, context.shopId, context.planId, "en", now);
            if (!selection) throw new PromotionDomainError(409, "promotion_integrity_invalid");
            return { schemaVersion: 1, revision, selection };
          }
          if (current && current.promotionalCreditGrant.campaign.expiresAt > now) {
            throw new PromotionDomainError(409, "promotion_selection_locked");
          }

          // The unique (campaignId, shopId) grant key preserves all accumulated
          // reserved/committed credit state, including on a later re-selection.
          const grant = await tx.promotionalCreditGrant.upsert({
            where: { campaignId_shopId: { campaignId: campaign.id, shopId: context.shopId } },
            create: { campaignId: campaign.id, shopId: context.shopId, quantity: campaign.quantity },
            update: {},
          });
          const remaining = remainingPromotionCredits(grant);
          if (grant.exhaustedAt || remaining === 0) {
            throw new PromotionDomainError(422, "promotion_exhausted");
          }
          await tx.promotionalCreditGrant.update({
            where: { id_shopId: { id: grant.id, shopId: context.shopId } },
            data: {
              firstSelectedAt: grant.firstSelectedAt ?? now,
              lastSelectedAt: now,
              selectionCount: { increment: 1 },
            },
          });
          await tx.merchantPromotionSelection.upsert({
            where: { shopId: context.shopId },
            create: { shopId: context.shopId, promotionalCreditGrantId: grant.id, selectedAt: now },
            update: {
              promotionalCreditGrantId: grant.id, selectedAt: now,
              version: { increment: 1 },
            },
          });
          const selected = await readPromotionSelection(tx, context.shopId, "en");
          const selection = selectedPromotion(selected, context.shopId, context.planId, "en", now);
          if (!selection) throw new PromotionDomainError(409, "promotion_integrity_invalid");
          return { schemaVersion: 1, revision: promotionRevision(context, selected), selection };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 12_000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code)) {
          if (attempt < 2) continue;
          throw new PromotionDomainError(409, "promotion_revision_conflict");
        }
        throw error;
      }
    }
    throw new PromotionDomainError(409, "promotion_revision_conflict");
  }
}
