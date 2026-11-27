import { Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../../auth/woo-installation/principal.js";
import { resolveRecoveryTimeZone } from "../query.js";
import {
  RecoveryDetailIntegrityError,
  boundedText,
  recoveryValue,
  type RecoveryDetailSummary,
} from "./contracts.js";
import type {
  RecoveryDetailPage,
  RecoveryDetailMessage,
  RecoveryRelatedItem,
} from "./contracts.js";
import { parseDetailNavigation, validRecoveryId } from "./cursor.js";
import { readMessagePage, readRelatedPage } from "./pages.js";
import { recoveryBasket } from "./basket.js";
import {
  humanMessagingProjection,
  recoveryConversationDetail,
} from "./conversation-projection.js";
import { attemptSelect, readRecoveryOutreach } from "./outreach-read.js";
import {
  MAX_OUTREACH_HISTORY,
  type RecoveryOutreachProjection,
} from "./outreach-projection.js";

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
  customer: {
    select: { shopId: true, firstName: true, lastName: true, email: true },
  },
  conversation: {
    select: {
      id: true,
      shopId: true,
      customerId: true,
      checkoutRecoveryId: true,
      controlMode: true,
      controlRevision: true,
    },
  },
  outreachAttempts: {
    orderBy: { sequence: "asc" },
    take: MAX_OUTREACH_HISTORY + 1,
    select: attemptSelect,
  },
} as const satisfies Prisma.CheckoutRecoverySelect;

const pageOwnershipSelect = {
  id: true,
  shopId: true,
  customerId: true,
  customer: { select: { shopId: true } },
  conversation: {
    select: {
      id: true,
      shopId: true,
      customerId: true,
      checkoutRecoveryId: true,
    },
  },
} as const satisfies Prisma.CheckoutRecoverySelect;

const outreachOwnershipSelect = {
  ...pageOwnershipSelect,
  generation: true,
  lastExternalActivityAt: true,
} as const satisfies Prisma.CheckoutRecoverySelect;

type ReadTransaction = Prisma.TransactionClient;

type OwnedRecovery = Prisma.CheckoutRecoveryGetPayload<{
  select: typeof pageOwnershipSelect;
}>;

interface ReadContext<Owned extends OwnedRecovery> {
  tx: ReadTransaction;
  owned: Owned;
  timeZone: string;
}

export class MerchantRecoveryDetailService {
  constructor(private readonly database: Pick<PrismaClient, "$transaction">) {}

  private async withOwned<T, Owned extends OwnedRecovery>(
    principal: WooInstallationPrincipal,
    recoveryId: string,
    load: (
      tx: ReadTransaction,
      where: Prisma.CheckoutRecoveryWhereInput,
    ) => Promise<Owned | null>,
    read: (context: ReadContext<Owned>) => Promise<T>,
  ): Promise<T | null> {
    if (!validRecoveryId(recoveryId)) return null;
    return this.database.$transaction(
      async (tx: ReadTransaction) => {
        const [shop, installation] = await Promise.all([
          tx.shop.findUnique({
            where: { id: principal.shopId },
            select: {
              id: true,
              domain: true,
              platform: true,
              shopifyShopId: true,
              status: true,
              defaultTimeZone: true,
            },
          }),
          tx.wooCommerceInstallation.findUnique({
            where: { id: principal.installationId },
            select: {
              id: true,
              shopId: true,
              canonicalSiteUrl: true,
              status: true,
              revokedAt: true,
              credentialVersion: true,
            },
          }),
        ]);
        if (
          !shop ||
          shop.id !== principal.shopId ||
          shop.domain !== principal.canonicalSiteUrl ||
          shop.platform !== "WOOCOMMERCE" ||
          shop.shopifyShopId !== null ||
          shop.status !== "ACTIVE" ||
          !installation ||
          installation.id !== principal.installationId ||
          installation.shopId !== principal.shopId ||
          installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
          installation.status !== "ACTIVE" ||
          installation.revokedAt !== null ||
          installation.credentialVersion !== principal.credentialVersion
        ) {
          throw new RecoveryDetailIntegrityError();
        }
        // Keep the concrete Prisma result type from each caller's selection.
        // Widening to CheckoutRecoverySelect loses nested outreach relations.
        const owned = await load(tx, {
          id: recoveryId,
          shopId: principal.shopId,
        });
        if (!owned) return null;
        if (
          owned.shopId !== principal.shopId ||
          (owned.customer && owned.customer.shopId !== principal.shopId) ||
          (owned.conversation &&
            (owned.conversation.checkoutRecoveryId !== owned.id ||
              (owned.conversation.shopId !== null &&
                owned.conversation.shopId !== principal.shopId) ||
              (owned.conversation.customerId !== null &&
                owned.conversation.customerId !== owned.customerId)))
        ) {
          throw new RecoveryDetailIntegrityError();
        }
        return read({
          tx,
          owned,
          timeZone: resolveRecoveryTimeZone(shop.defaultTimeZone),
        });
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  async summary(
    principal: WooInstallationPrincipal,
    recoveryId: string,
  ): Promise<RecoveryDetailSummary | null> {
    return this.withOwned(
      principal,
      recoveryId,
      (tx, where) =>
        tx.checkoutRecovery.findFirst({ where, select: recoverySelect }),
      async ({ tx, owned, timeZone }) => {
        const now = new Date();
        const [restriction, conversation] = await Promise.all([
          tx.shopHumanMessagingRestriction.findUnique({
            where: { shopId: principal.shopId },
            select: { status: true },
          }),
          recoveryConversationDetail(
            tx,
            owned.conversation,
            {
              shopId: principal.shopId,
              recoveryId: owned.id,
              platform: "WOOCOMMERCE",
            },
            owned.outreachAttempts,
            now,
          ),
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
          customer: owned.customer
            ? {
                firstName: boundedText(owned.customer.firstName, 80),
                lastName: boundedText(owned.customer.lastName, 80),
                email: boundedText(owned.customer.email, 320),
              }
            : null,
          hasConversation: Boolean(owned.conversation),
          milestones: {
            detectedAt: owned.detectedAt.toISOString(),
            messageSentAt: owned.messageSentAt?.toISOString() ?? null,
            engagedAt: owned.engagedAt?.toISOString() ?? null,
            completedAt: owned.completedAt?.toISOString() ?? null,
            expiredAt: owned.expiredAt?.toISOString() ?? null,
          },
        } satisfies RecoveryDetailSummary;
      },
    );
  }

  async outreach(
    principal: WooInstallationPrincipal,
    recoveryId: string,
  ): Promise<RecoveryOutreachProjection | null> {
    return this.withOwned(
      principal,
      recoveryId,
      (tx, where) =>
        tx.checkoutRecovery.findFirst({
          where,
          select: outreachOwnershipSelect,
        }),
      async ({ tx, owned }) =>
        readRecoveryOutreach(tx, {
          shopId: principal.shopId,
          recoveryId: owned.id,
          conversationId: owned.conversation?.id ?? null,
          generation: owned.generation,
          lastExternalActivityAt: owned.lastExternalActivityAt,
        }),
    );
  }

  async messages(
    principal: WooInstallationPrincipal,
    recoveryId: string,
    params: URLSearchParams,
  ): Promise<RecoveryDetailPage<RecoveryDetailMessage> | null> {
    const navigation = parseDetailNavigation(
      principal.shopId,
      recoveryId,
      "messages",
      params,
    );
    return this.withOwned(
      principal,
      recoveryId,
      (tx, where) =>
        tx.checkoutRecovery.findFirst({ where, select: pageOwnershipSelect }),
      async ({ tx, owned }) => {
        if (!owned.conversation) {
          const empty: RecoveryDetailPage<RecoveryDetailMessage> = {
            schemaVersion: 1,
            items: [],
            previousCursor: null,
            nextCursor: null,
          };
          return empty;
        }
        return readMessagePage(
          tx,
          principal.shopId,
          recoveryId,
          owned.conversation.id,
          navigation,
        );
      },
    );
  }

  async related(
    principal: WooInstallationPrincipal,
    recoveryId: string,
    params: URLSearchParams,
  ): Promise<RecoveryDetailPage<RecoveryRelatedItem> | null> {
    const navigation = parseDetailNavigation(
      principal.shopId,
      recoveryId,
      "related",
      params,
    );
    return this.withOwned(
      principal,
      recoveryId,
      (tx, where) =>
        tx.checkoutRecovery.findFirst({ where, select: pageOwnershipSelect }),
      async ({ tx, owned }) => {
        if (!owned.customerId) {
          const empty: RecoveryDetailPage<RecoveryRelatedItem> = {
            schemaVersion: 1,
            items: [],
            previousCursor: null,
            nextCursor: null,
          };
          return empty;
        }
        return readRelatedPage(
          tx,
          principal.shopId,
          recoveryId,
          owned.customerId,
          navigation,
        );
      },
    );
  }
}
