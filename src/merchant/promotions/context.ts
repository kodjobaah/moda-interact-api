import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { PromotionDomainError } from "./contract.js";

export type PromotionTransaction = Prisma.TransactionClient;
export type PromotionDatabase = Pick<PrismaClient, "$transaction">;

interface ShopIdentity {
  id: string;
  domain: string;
  platform: string;
  shopifyShopId: string | null;
  status: string;
}

export interface PromotionMerchantContext {
  shopId: string;
  planId: string;
  subscriptionId: string;
  subscriptionStatus: string;
  subscriptionUpdatedAt: Date;
}

/** Revocation and shop ownership are rechecked inside every read/write transaction. */
export async function requirePromotionMerchant(
  tx: PromotionTransaction, principal: WooInstallationPrincipal, lock: boolean,
): Promise<PromotionMerchantContext> {
  const shop: ShopIdentity | null = lock
    ? (await tx.$queryRaw<ShopIdentity[]>(Prisma.sql`
      SELECT "id", "domain", "platform", "shopifyShopId", "status"
      FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
    `))[0] ?? null
    : await tx.shop.findUnique({
      where: { id: principal.shopId },
      select: { id: true, domain: true, platform: true, shopifyShopId: true, status: true },
    });
  if (!shop || shop.status !== "ACTIVE" || shop.platform !== "WOOCOMMERCE" ||
    shop.shopifyShopId !== null || shop.domain !== principal.canonicalSiteUrl) {
    throw new WooUnauthenticatedError();
  }

  const installation = lock
    ? (await tx.$queryRaw<Array<{
      id: string; shopId: string; canonicalSiteUrl: string; status: string;
      credentialVersion: number; revokedAt: Date | null;
    }>>(Prisma.sql`
      SELECT "id", "shopId", "canonicalSiteUrl", "status", "credentialVersion", "revokedAt"
      FROM "woocommerce"."WooCommerceInstallation"
      WHERE "id" = ${principal.installationId} FOR SHARE
    `))[0] ?? null
    : await tx.wooCommerceInstallation.findUnique({
      where: { id: principal.installationId },
      select: { id: true, shopId: true, canonicalSiteUrl: true, status: true, credentialVersion: true, revokedAt: true },
    });
  if (!installation || installation.shopId !== shop.id ||
    installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
    installation.status !== "ACTIVE" || installation.revokedAt !== null ||
    installation.credentialVersion !== principal.credentialVersion) {
    throw new WooUnauthenticatedError();
  }

  const subscription = await tx.subscription.findUnique({
    where: { shopId: principal.shopId },
    select: {
      id: true, status: true, planId: true, updatedAt: true,
      plan: { select: { id: true, active: true } },
    },
  });
  if (!subscription || !["ACTIVE", "TRIALING"].includes(subscription.status) ||
    !subscription.planId || !subscription.plan?.active || subscription.plan.id !== subscription.planId) {
    throw new PromotionDomainError(409, "promotion_unavailable");
  }
  return {
    shopId: shop.id,
    planId: subscription.planId,
    subscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    subscriptionUpdatedAt: subscription.updatedAt,
  };
}

export async function readPromotionSelection(
  tx: PromotionTransaction, shopId: string, locale: string,
) {
  return tx.merchantPromotionSelection.findUnique({
    where: { shopId },
    select: {
      id: true, version: true, updatedAt: true, promotionalCreditGrantId: true,
      promotionalCreditGrant: {
        select: {
          id: true, shopId: true, quantity: true, reservedQuantity: true, committedQuantity: true,
          exhaustedAt: true, version: true,
          campaign: {
            select: {
              id: true, name: true, scope: true, status: true, startsAt: true, expiresAt: true,
              targetPlanId: true, targetShopId: true,
              translations: { where: { locale: { in: [locale, "en"] } }, select: { locale: true, merchantTitle: true } },
            },
          },
        },
      },
    },
  });
}

export type StoredPromotionSelection = NonNullable<Awaited<ReturnType<typeof readPromotionSelection>>>;

/** The revision is based on durable shop/plan/selection/grant state, never a client balance. */
export function promotionRevision(
  context: PromotionMerchantContext, selection: StoredPromotionSelection | null,
): string {
  const grant = selection?.promotionalCreditGrant;
  return createHash("sha256").update(JSON.stringify([
    context.shopId, context.subscriptionId, context.subscriptionStatus, context.planId,
    context.subscriptionUpdatedAt.toISOString(),
    selection?.id ?? null, selection?.version ?? null, selection?.promotionalCreditGrantId ?? null,
    selection?.updatedAt.toISOString() ?? null,
    grant?.version ?? null, grant?.quantity ?? null, grant?.reservedQuantity ?? null,
    grant?.committedQuantity ?? null, grant?.exhaustedAt?.toISOString() ?? null,
    grant?.campaign.id ?? null, grant?.campaign.status ?? null,
    grant?.campaign.startsAt.toISOString() ?? null, grant?.campaign.expiresAt.toISOString() ?? null,
    grant?.campaign.scope ?? null, grant?.campaign.targetPlanId ?? null, grant?.campaign.targetShopId ?? null,
  ])).digest("hex");
}
