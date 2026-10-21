import type { Prisma } from "@prisma/client";
import { CUSTOMER_SERVICE_WINDOW_MS, latestVerifiedCustomerInbound } from "../../conversations/messages/eligibility.js";
import type { RecoveryConversationDetail, RecoveryDetailSummary } from "./contracts.js";

interface Outreach {
  sequence: number;
  sentAt: Date | null;
  status: string;
  initiatedBy: "HUMAN" | "AGENT" | "AUTOMATION" | null;
  initiationKey: string | null;
  outboundMessageId: string | null;
}
interface Conversation {
  id: string;
  controlMode: "AI" | "HUMAN";
  controlRevision: number;
}

/** Read-only presentation; POST admission alone decides actual send eligibility. */
export async function recoveryConversationDetail(
  tx: Prisma.TransactionClient,
  conversation: Conversation | null,
  attempts: readonly Outreach[],
  now: Date,
): Promise<RecoveryConversationDetail | null> {
  if (!conversation) return null;
  const initial = attempts.find((item) => item.sequence === 1);
  const sequenceTwo = attempts.find((item) => item.sequence === 2);
  const lastInbound = initial?.sentAt
    ? await latestVerifiedCustomerInbound(tx, conversation.id, initial.sentAt, now) : null;
  return {
    id: conversation.id,
    controlMode: conversation.controlMode,
    controlRevision: conversation.controlRevision,
    lastInboundAt: lastInbound?.toISOString() ?? null,
    windowExpiresAt: lastInbound ? new Date(lastInbound.getTime() + CUSTOMER_SERVICE_WINDOW_MS).toISOString() : null,
    followUp: {
      sequence2Used: !!sequenceTwo && (sequenceTwo.initiationKey !== null || sequenceTwo.initiatedBy !== null ||
        sequenceTwo.status !== "PENDING" || sequenceTwo.outboundMessageId !== null),
      initiatedBy: sequenceTwo?.initiatedBy ?? null,
    },
  };
}

/** Missing restriction rows are ACTIVE, but an unexpected value never grants access. */
export function humanMessagingProjection(status: string | null): Pick<RecoveryDetailSummary,
  "humanMessagingAllowed" | "humanMessagingStatus"> {
  if (status === null || status === "ACTIVE") return { humanMessagingAllowed: true, humanMessagingStatus: "ACTIVE" };
  if (status === "SUSPENDED") return { humanMessagingAllowed: false, humanMessagingStatus: "SUSPENDED" };
  return { humanMessagingAllowed: false, humanMessagingStatus: "SUSPENDED" };
}
