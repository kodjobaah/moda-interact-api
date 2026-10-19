import { Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../../auth/woo-installation/principal.js";
import { SendHttpError, type ModerationStatus, type SendStatusResponse } from "./contract.js";
import { ownedRecoveryConversation, requireCurrentWooShop } from "./admission.service.js";

const moderation: Record<string, ModerationStatus> = {
  PENDING: "moderation_pending", CHECKING: "moderation_pending",
  ALLOW: "moderation_allowed", BLOCK: "moderation_blocked",
  REVIEW_REQUIRED: "moderation_review_required", RETRYABLE_ERROR: "moderation_retryable_error",
};
const safeReasons = new Set([
  "human_messaging_suspended", "human_rate_limited", "human_repeated_spam",
  "human_content_invalid", "human_screening_unavailable", "moderation_unavailable",
  "moderation_content_stale", "human_content_moderation_blocked", "human_content_moderation_review_required",
  "provider_rejected", "follow_up_unavailable", "customer_window_closed",
  "human_inactive", "stale_control_revision", "recipient_unavailable",
]);

/** Status is a projection over the original command and matching D005 assessment.
 * An old ALLOW for different content cannot be shown as current approval.
 */
export class MerchantConversationSendStatusService {
  constructor(private readonly database: Pick<PrismaClient, "$transaction">) {}
  async read(principal: WooInstallationPrincipal, conversationId: string,
    commandId: string): Promise<SendStatusResponse> {
    return this.database.$transaction(async (tx) => {
      await requireCurrentWooShop(tx, principal, false);
      await ownedRecoveryConversation(tx, principal.shopId, conversationId, false);
      const cmd = await tx.merchantConversationSendCommand.findFirst({ where: {
        id: commandId, shopId: principal.shopId, conversationId,
      }, select: { id: true, conversationId: true, shopId: true, kind: true, state: true,
        textBody: true, templateName: true, templateLanguageCode: true, templateParameters: true,
        createdAt: true, updatedAt: true, outboundMessageId: true, failureCode: true,
      } });
      if (!cmd) throw new SendHttpError(404,"not_found");
      // SQL computes the digest from the *persisted* command. The template
      // renderer is DATABASE-005's authoritative v1 contract.
      const assessments = await tx.$queryRaw<Array<{ decision: string }>>(Prisma.sql`
        SELECT "decision"::text AS "decision"
        FROM "whatsapp"."ConversationModerationAssessment"
        WHERE "merchantSendCommandId"=${cmd.id} AND "shopId"=${principal.shopId}
          AND "conversationId"=${conversationId}
          AND "inputKind"=CASE WHEN ${cmd.kind}='HUMAN_TEXT' THEN 'TEXT' ELSE 'TEMPLATE_PARAMETERS' END
          AND "contentSha256"= (
            SELECT encode(sha256(convert_to(
              CASE WHEN c."kind"='HUMAN_TEXT' THEN c."textBody"
                   ELSE "whatsapp".arch040_moderation_template_input_v1(
                     c."templateName", c."templateLanguageCode", c."templateParameters") END,
              'UTF8')),'hex')
            FROM "whatsapp"."MerchantConversationSendCommand" c WHERE c."id"=${cmd.id}
          )
        ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
      `);
      const lastDecision = assessments[0]?.decision ?? "PENDING";
      const moderationStatus = moderation[lastDecision];
      if (!moderationStatus) throw new Error("Invalid persisted moderation state");
      const safeFailure = cmd.failureCode && safeReasons.has(cmd.failureCode) ? cmd.failureCode : null;
      const failureCode = moderationStatus === "moderation_blocked"
        ? "HUMAN_CONTENT_MODERATION_BLOCKED"
        : safeFailure;
      return {
        schemaVersion: 1, commandId: cmd.id, conversationId: cmd.conversationId,
        kind: cmd.kind, state: cmd.state,
        createdAt: cmd.createdAt.toISOString(), updatedAt: cmd.updatedAt.toISOString(),
        messageId: cmd.outboundMessageId, failureCode, moderationStatus,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
