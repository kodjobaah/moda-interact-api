import { Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../../auth/woo-installation/principal.js";
import { WooUnauthenticatedError } from "../../../auth/woo-installation/authenticator.js";
import {
  ConversationControlConflictError, ConversationControlIntegrityError,
  ConversationControlNotFoundError, ConversationControlSuspendedError,
  type ConversationControlRequest, type ConversationControlResponse,
  type ConversationControlTarget,
} from "./contract.js";

interface ShopRow {
  id: string; domain: string; platform: string; status: string; shopifyShopId: unknown;
}
interface InstallationRow {
  id: string; shopId: string; canonicalSiteUrl: string;
  status: string; revokedAt: Date | null; credentialVersion: number;
}
interface ConversationRow {
  id: string; shopId: string | null; checkoutRecoveryId: string;
  type: string; controlMode: ConversationControlTarget;
  controlRevision: number; controlChangedAt: Date | null; inboundVersion: number;
}

/** Short transaction: Shop -> installation -> recovery conversation -> event.
 * Locking Shop also serialises the no-restriction-row case against admin suspension.
 */
export class MerchantConversationControlService {
  constructor(
    private readonly database: Pick<PrismaClient, "$transaction">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async change(principal: WooInstallationPrincipal, conversationId: string,
    input: ConversationControlRequest): Promise<ConversationControlResponse> {
    try {
      return await this.database.$transaction(async (tx) => {
        const shops = await tx.$queryRaw<ShopRow[]>`SELECT "id", "domain", "platform"::text AS "platform",
          "status"::text AS "status", "shopifyShopId" FROM "commerce"."Shop"
          WHERE "id"=${principal.shopId} FOR UPDATE`;
        const shop = shops[0];
        if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
          shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE") {
          throw new WooUnauthenticatedError();
        }
        // Recheck the credential *inside* this transaction: authentication may
        // have preceded installation revocation or credential rotation.
        const installations = await tx.$queryRaw<InstallationRow[]>`SELECT "id", "shopId", "canonicalSiteUrl",
          "credentialVersion", "status"::text AS "status", "revokedAt"
          FROM "woocommerce"."WooCommerceInstallation"
          WHERE "id"=${principal.installationId} FOR SHARE`;
        const installation = installations[0];
        if (!installation || installation.shopId !== principal.shopId ||
          installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
          installation.credentialVersion !== principal.credentialVersion ||
          installation.status !== "ACTIVE" || installation.revokedAt !== null) {
          throw new WooUnauthenticatedError();
        }

        // Ownership is proven through CheckoutRecovery.shopId, never the
        // optional Conversation.shopId. Both rows stay locked through commit.
        const rows = await tx.$queryRaw<ConversationRow[]>`SELECT c."id", c."shopId", c."checkoutRecoveryId",
          c."type"::text AS "type", c."controlMode"::text AS "controlMode",
          c."controlRevision", c."controlChangedAt", c."inboundVersion"
          FROM "whatsapp"."Conversation" c
          INNER JOIN "commerce"."CheckoutRecovery" r ON r."id"=c."checkoutRecoveryId"
          WHERE c."id"=${conversationId} AND r."shopId"=${principal.shopId}
          FOR UPDATE OF c FOR SHARE OF r`;
        const current = rows[0];
        if (!current) throw new ConversationControlNotFoundError();
        if ((current.shopId !== null && current.shopId !== principal.shopId) ||
          current.type !== "RECOVERY" || !Number.isSafeInteger(current.controlRevision) ||
          current.controlRevision < 0 || (current.controlRevision === 0 && current.controlMode !== "AI")) {
          throw new ConversationControlIntegrityError();
        }
        if (current.controlRevision !== input.expectedControlRevision) {
          throw new ConversationControlConflictError("stale_control_revision", {
            controlMode: current.controlMode, controlRevision: current.controlRevision,
          });
        }
        if (input.targetMode === "HUMAN") {
          const restrictions = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS "status"
            FROM "commerce"."ShopHumanMessagingRestriction" WHERE "shopId"=${principal.shopId}`;
          if (restrictions[0]?.status === "SUSPENDED") throw new ConversationControlSuspendedError();
          if (restrictions[0] && restrictions[0].status !== "ACTIVE") throw new ConversationControlIntegrityError();
        }
        if (current.controlMode === input.targetMode) return {
          schemaVersion: 1, conversationId: current.id, controlMode: current.controlMode,
          controlRevision: current.controlRevision, controlChangedAt: current.controlChangedAt?.toISOString() ?? null,
        };
        if (current.controlRevision >= 2_147_483_647) throw new ConversationControlConflictError("conversation_control_conflict");
        const instant = this.now().getTime();
        if (!Number.isFinite(instant)) throw new ConversationControlIntegrityError();
        const previousTime = current.controlChangedAt?.getTime() ?? -Infinity;
        const occurredAt = new Date(Math.max(instant, previousTime + 1));
        const changed = await tx.conversation.updateMany({
          where: { id: current.id, checkoutRecoveryId: current.checkoutRecoveryId,
            controlMode: current.controlMode, controlRevision: current.controlRevision },
          data: {
            controlMode: input.targetMode, controlRevision: { increment: 1 }, controlChangedAt: occurredAt,
            pendingTurnStartedAt: null, pendingAiNotBeforeAt: null, pendingAiControlRevision: null,
            pendingAiDelayMinutes: null, processingInboundVersion: null, processingStartedAt: null,
            lastProcessedVersion: current.inboundVersion,
          },
        });
        if (changed.count !== 1) throw new ConversationControlConflictError("conversation_control_conflict");
        await tx.conversationControlEvent.create({ data: {
          conversationId: current.id, fromMode: current.controlMode, toMode: input.targetMode,
          fromRevision: current.controlRevision, toRevision: current.controlRevision + 1, occurredAt,
        } });
        return {
          schemaVersion: 1, conversationId: current.id, controlMode: input.targetMode,
          controlRevision: current.controlRevision + 1, controlChangedAt: occurredAt.toISOString(),
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034"].includes(error.code)) {
        throw new ConversationControlConflictError("conversation_control_conflict");
      }
      throw error;
    }
  }
}
