import type { Prisma, PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooRestoreOutreachOfferV1 } from "@modainteract/moda-interact-shared/woocommerce";
import { parseWooOfferReceipt } from "./offer-receipt.js";
import { attemptSelect } from "../../merchant/recoveries/detail/outreach-read.js";
import { MAX_OUTREACH_HISTORY } from "../../merchant/recoveries/detail/outreach-projection.js";
import { hasConfirmedOutreachDelivery, selectEffectiveOutreachAttempt } from "../../merchant/recoveries/detail/outreach-lineage.js";
import { confirmedRetry } from "../../merchant/recoveries/detail/merchant-outreach.js";

export const restoreOfferAttemptSelect = {
  ...attemptSelect,
  checkoutRecovery: { select: { shopId: true, generation: true, conversation: { select: { id: true, type: true, shopId: true } } } },
  outboundMessage: { select: { ...attemptSelect.outboundMessage.select, content: true } },
} as const satisfies Prisma.RecoveryOutreachAttemptSelect;

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
    const attempts = await this.database.recoveryOutreachAttempt.findMany({
      where: { checkoutRecoveryId: input.recoveryId, checkoutRecovery: { shopId: input.shopId, generation: input.generation } },
      orderBy: { sequence: "asc" }, take: MAX_OUTREACH_HISTORY + 1,
      select: restoreOfferAttemptSelect,
    });
    if (attempts.length > MAX_OUTREACH_HISTORY || attempts.some(attempt =>
      attempt.checkoutRecoveryId !== input.recoveryId || attempt.checkoutRecovery.shopId !== input.shopId ||
      attempt.checkoutRecovery.generation !== input.generation)) return this.unverifiable(input, "attempt_scope_mismatch");
    const selection = selectEffectiveOutreachAttempt({ ...input, slot: "INITIAL", attempts });
    if (selection.kind === "missing") return noConfirmedOffer;
    if (selection.kind === "conflict") return this.unverifiable(input, "retry_lineage_conflict");
    const attempt = selection.current;
    if (!attempt.sentAt || !attempt.outboundMessageId) return noConfirmedOffer;
    const message = attempt.outboundMessage;
    const conversation = attempt.checkoutRecovery.conversation;
    if (!message || message.id !== attempt.outboundMessageId || !input.conversationId ||
      !conversation || conversation.id !== input.conversationId || conversation.type !== "RECOVERY" ||
      (conversation.shopId !== null && conversation.shopId !== input.shopId) ||
      message.conversationId !== input.conversationId || message.direction !== "OUTBOUND" ||
      message.senderType !== "AUTOMATION" || !["SENT", "DELIVERED", "READ"].includes(message.status) ||
      !message.providerMessageId) return this.unverifiable(input, "confirmed_message_mismatch");
    // Keep historical SENT behavior for an ordinary initial attempt. A retry
    // must prove actual positive delivery and its exact historical admission.
    // Never fall back to a superseded offer, including while a retry is pending.
    if (attempt.deliveryRetryIntent && !attempt.deliveryRetryIntent.cancelledAt) return noConfirmedOffer;
    if (attempt.status === "FAILED" && !hasConfirmedOutreachDelivery(attempt, input.conversationId)) return noConfirmedOffer;
    if (selection.retryCount > 0 && !confirmedRetry({ ...input, conversationId: input.conversationId,
      platform: "WOOCOMMERCE" }, selection.chain, attempt)) return noConfirmedOffer;

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
    reason: "attempt_scope_mismatch" | "confirmed_message_mismatch" | "retry_lineage_conflict",
  ): WooRestoreOutreachOfferV1 {
    this.logger.warn("woocommerce.recovery_restore.offer.unverifiable", {
      shopId: input.shopId,
      recoveryId: input.recoveryId,
      reason,
    });
    return unverifiableOffer;
  }
}
