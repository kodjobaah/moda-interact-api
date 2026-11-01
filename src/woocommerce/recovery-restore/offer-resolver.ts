import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooRestoreOutreachOfferV1 } from "@modainteract/moda-interact-shared/woocommerce";
import { parseWooOfferReceipt } from "./offer-receipt.js";

type Database = Pick<PrismaClient, "recoveryOutreachAttempt">;

export interface ConfirmedWooSentOfferReader {
  read(input: {
    shopId: string;
    recoveryId: string;
    generation: number;
    conversationId: string | null;
  }): Promise<WooRestoreOutreachOfferV1>;
}

const noConfirmedOffer: WooRestoreOutreachOfferV1 = { kind: "NONE", reason: "NO_CONFIRMED_OFFER" };
const unverifiableOffer: WooRestoreOutreachOfferV1 = { kind: "NONE", reason: "UNVERIFIABLE" };

export class WooConfirmedSentOfferResolver implements ConfirmedWooSentOfferReader {
  constructor(private readonly database: Database, private readonly logger: StructuredLogger) {}

  async read(input: {
    shopId: string;
    recoveryId: string;
    generation: number;
    conversationId: string | null;
  }): Promise<WooRestoreOutreachOfferV1> {
    const attempt = await this.database.recoveryOutreachAttempt.findUnique({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: input.recoveryId, sequence: 1 } },
      select: {
        checkoutRecoveryId: true,
        sequence: true,
        sentAt: true,
        outboundMessageId: true,
        checkoutRecovery: {
          select: {
            shopId: true,
            generation: true,
            conversation: { select: { id: true } },
          },
        },
        outboundMessage: {
          select: {
            id: true,
            conversationId: true,
            direction: true,
            senderType: true,
            status: true,
            providerMessageId: true,
            content: true,
          },
        },
      },
    });
    if (!attempt) return noConfirmedOffer;
    if (attempt.checkoutRecoveryId !== input.recoveryId || attempt.sequence !== 1 ||
      attempt.checkoutRecovery.shopId !== input.shopId ||
      attempt.checkoutRecovery.generation !== input.generation) {
      return this.unverifiable(input, "attempt_scope_mismatch");
    }
    if (!attempt.sentAt || !attempt.outboundMessageId) return noConfirmedOffer;

    const message = attempt.outboundMessage;
    const expectedConversationId = attempt.checkoutRecovery.conversation?.id;
    if (!message || message.id !== attempt.outboundMessageId ||
      !input.conversationId || expectedConversationId !== input.conversationId ||
      message.conversationId !== input.conversationId || message.direction !== "OUTBOUND" ||
      message.senderType !== "AUTOMATION" ||
      !["SENT", "DELIVERED", "READ"].includes(message.status) ||
      message.providerMessageId === null) {
      return this.unverifiable(input, "confirmed_message_mismatch");
    }

    const parsed = parseWooOfferReceipt(message.content);
    if (parsed.warning) {
      this.logger.warn("woocommerce.recovery_restore.offer.unverifiable", {
        shopId: input.shopId,
        recoveryId: input.recoveryId,
        reason: parsed.warning,
      });
    }
    return parsed.offer;
  }

  private unverifiable(
    input: { shopId: string; recoveryId: string },
    reason: "attempt_scope_mismatch" | "confirmed_message_mismatch",
  ): WooRestoreOutreachOfferV1 {
    this.logger.warn("woocommerce.recovery_restore.offer.unverifiable", {
      shopId: input.shopId,
      recoveryId: input.recoveryId,
      reason,
    });
    return unverifiableOffer;
  }
}