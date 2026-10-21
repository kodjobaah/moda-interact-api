import { Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../../auth/woo-installation/principal.js";
import { resolveRecoveryTimeZone } from "../query.js";
import {
  RecoveryDetailIntegrityError,
  boundedText,
  recoveryValue,
  type RecoveryDetailSummary,
} from "./contracts.js";
import type { RecoveryDetailPage, RecoveryDetailMessage, RecoveryRelatedItem } from "./contracts.js";
import { parseDetailNavigation, validRecoveryId } from "./cursor.js";
import { readMessagePage, readRelatedPage } from "./pages.js";
import { recoveryBasket } from "./basket.js";
import { humanMessagingProjection, recoveryConversationDetail } from "./conversation-projection.js";

const recoverySelect = {
  id: true,
  status: true,
  shopId: true,
  customerId: true,
  totalPrice: true,
  currency: true,
  lineItems: true,
  detectedAt: true,
  messageSentAt: true,
  engagedAt: true,
  completedAt: true,
  expiredAt: true,
  customer: { select: { shopId: true, firstName: true, lastName: true, email: true } },
  conversation: { select: { id: true, shopId: true, customerId: true, checkoutRecoveryId: true,
    controlMode: true, controlRevision: true } },
  outreachAttempts: { where: { sequence: { in: [1, 2] } }, select: {
    sequence: true, sentAt: true, status: true, initiatedBy: true, initiationKey: true,
    outboundMessageId: true,
  } },
} as const satisfies Prisma.CheckoutRecoverySelect;

export type OwnedRecovery = Prisma.CheckoutRecoveryGetPayload<{ select: typeof recoverySelect }>;

type ReadTransaction = Prisma.TransactionClient;

interface ReadContext {
  tx: ReadTransaction;
  owned: OwnedRecovery;
  timeZone: string;
}

export class MerchantRecoveryDetailService {
  constructor(private readonly database: Pick<PrismaClient, "$transaction">) {}

  private async withOwned<T>(
    principal: WooInstallationPrincipal,
    recoveryId: string,
    read: (context: ReadContext) => Promise<T>,
  ): Promise<T | null> {
    if (!validRecoveryId(recoveryId)) return null;
    return this.database.$transaction(async (tx: ReadTransaction) => {
      const [shop, installation] = await Promise.all([
        tx.shop.findUnique({
          where: { id: principal.shopId },
          select: {
            id: true, domain: true, platform: true, shopifyShopId: true,
            status: true, defaultTimeZone: true,
          },
        }),
        tx.wooCommerceInstallation.findUnique({
          where: { id: principal.installationId },
          select: {
            id: true, shopId: true, canonicalSiteUrl: true, status: true,
            revokedAt: true, credentialVersion: true,
          },
        }),
      ]);
      if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
        shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE" ||
        !installation || installation.id !== principal.installationId ||
        installation.shopId !== principal.shopId ||
        installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
        installation.status !== "ACTIVE" || installation.revokedAt !== null ||
        installation.credentialVersion !== principal.credentialVersion) {
        throw new RecoveryDetailIntegrityError();
      }
      const owned = await tx.checkoutRecovery.findFirst({
        where: { id: recoveryId, shopId: principal.shopId },
        select: recoverySelect,
      });
      if (!owned) return null;
      if (owned.shopId !== principal.shopId ||
        (owned.customer && owned.customer.shopId !== principal.shopId) ||
        (owned.conversation && (owned.conversation.checkoutRecoveryId !== owned.id ||
          (owned.conversation.shopId !== null && owned.conversation.shopId !== principal.shopId) ||
          (owned.conversation.customerId !== null && owned.conversation.customerId !== owned.customerId)))) {
        throw new RecoveryDetailIntegrityError();
      }
      return read({ tx, owned, timeZone: resolveRecoveryTimeZone(shop.defaultTimeZone) });
    }, { isolationLevel: "RepeatableRead" });
  }

  async summary(principal: WooInstallationPrincipal, recoveryId: string): Promise<RecoveryDetailSummary | null> {
    return this.withOwned(principal, recoveryId, async ({ tx, owned, timeZone }) => {
      const now = new Date();
      const [restriction, conversation] = await Promise.all([
        tx.shopHumanMessagingRestriction.findUnique({ where: { shopId: principal.shopId },
          select: { status: true } }),
        recoveryConversationDetail(tx, owned.conversation, owned.outreachAttempts, now),
      ]);
      const value = recoveryValue(owned.totalPrice, owned.currency);
      return {
        schemaVersion: 1,
        timeZone,
        id: owned.id,
        status: owned.status,
        value,
        basket: recoveryBasket(owned.lineItems, value, owned.currency),
        conversation,
        ...humanMessagingProjection(restriction?.status ?? null),
        customer: owned.customer ? {
          firstName: boundedText(owned.customer.firstName, 80),
          lastName: boundedText(owned.customer.lastName, 80),
          email: boundedText(owned.customer.email, 320),
        } : null,
        hasConversation: Boolean(owned.conversation),
        milestones: {
          detectedAt: owned.detectedAt.toISOString(),
          messageSentAt: owned.messageSentAt?.toISOString() ?? null,
          engagedAt: owned.engagedAt?.toISOString() ?? null,
          completedAt: owned.completedAt?.toISOString() ?? null,
          expiredAt: owned.expiredAt?.toISOString() ?? null,
        },
      } satisfies RecoveryDetailSummary;
    });
  }

  async messages(
    principal: WooInstallationPrincipal,
    recoveryId: string,
    params: URLSearchParams,
  ): Promise<RecoveryDetailPage<RecoveryDetailMessage> | null> {
    const navigation = parseDetailNavigation(principal.shopId, recoveryId, "messages", params);
    return this.withOwned(principal, recoveryId, async ({ tx, owned }) => {
      if (!owned.conversation) {
        const empty: RecoveryDetailPage<RecoveryDetailMessage> = {
          schemaVersion: 1, items: [], previousCursor: null, nextCursor: null,
        };
        return empty;
      }
      return readMessagePage(tx, principal.shopId, recoveryId, owned.conversation.id, navigation);
    });
  }

  async related(
    principal: WooInstallationPrincipal,
    recoveryId: string,
    params: URLSearchParams,
  ): Promise<RecoveryDetailPage<RecoveryRelatedItem> | null> {
    const navigation = parseDetailNavigation(principal.shopId, recoveryId, "related", params);
    return this.withOwned(principal, recoveryId, async ({ tx, owned }) => {
      if (!owned.customerId) {
        const empty: RecoveryDetailPage<RecoveryRelatedItem> = {
          schemaVersion: 1, items: [], previousCursor: null, nextCursor: null,
        };
        return empty;
      }
      return readRelatedPage(tx, principal.shopId, recoveryId, owned.customerId, navigation);
    });
  }
}
