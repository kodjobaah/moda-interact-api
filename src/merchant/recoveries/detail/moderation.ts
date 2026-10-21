import { Prisma } from "@prisma/client";
import {
  publicModerationDecision,
  publicModerationReason,
  type PublicModerationDecision,
} from "../../conversations/moderation/read-projection.js";

export type MessageModeration = {
  moderationStatus: PublicModerationDecision;
  moderationReasonCode: string | null;
};
const pending: MessageModeration = { moderationStatus: "PENDING", moderationReasonCode: null };

/** One bounded query for each 50-message page. Assessments are applicable only
 * when their digest matches the *currently persisted* message content and input kind.
 * Do not treat an older ALLOW for changed content as the latest approval.
 */
export async function readMessageModeration(
  tx: Prisma.TransactionClient,
  shopId: string,
  conversationId: string,
  messageIds: readonly string[],
): Promise<Map<string, MessageModeration>> {
  const result = new Map<string, MessageModeration>();
  if (!messageIds.length) return result;
  const rows = await tx.$queryRaw<Array<{ messageId: string; decision: string; reasonCode: string | null }>>(Prisma.sql`
    SELECT DISTINCT ON (a."conversationMessageId")
      a."conversationMessageId" AS "messageId", a."decision"::text AS "decision", a."reasonCode"
    FROM "whatsapp"."ConversationModerationAssessment" a
    JOIN "whatsapp"."ConversationMessage" m ON m."id"=a."conversationMessageId"
    WHERE a."shopId"=${shopId} AND a."conversationId"=${conversationId}
      AND m."conversationId"=${conversationId}
      AND m."id" IN (${Prisma.join([...messageIds])})
      AND m."contentType" IN ('TEXT','AUDIO')
      AND (m."contentType"='TEXT' OR m."transcriptionStatus"='COMPLETED')
      AND a."inputKind"=CASE WHEN m."contentType"='AUDIO' THEN 'TRANSCRIPT' ELSE 'TEXT' END
      AND a."contentSha256"=encode(sha256(convert_to(m."content",'UTF8')),'hex')
    ORDER BY a."conversationMessageId", a."createdAt" DESC, a."id" DESC
  `);
  for (const row of rows) {
    if (!messageIds.includes(row.messageId)) continue;
    const moderationStatus = publicModerationDecision(row.decision);
    result.set(row.messageId, { moderationStatus,
      moderationReasonCode: publicModerationReason(moderationStatus, row.reasonCode) });
  }
  return result;
}
export function messageModeration(id: string, byId: ReadonlyMap<string, MessageModeration>): MessageModeration {
  return byId.get(id) ?? pending;
}
