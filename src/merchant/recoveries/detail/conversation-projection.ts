import type { Prisma } from "@prisma/client";
import {
  CUSTOMER_SERVICE_WINDOW_MS,
  latestVerifiedCustomerInbound,
} from "../../conversations/messages/eligibility.js";
import type {
  RecoveryConversationDetail,
  RecoveryDetailSummary,
} from "./contracts.js";

import {
  resolveMerchantOutreach,
  type MerchantOutreachAttempt,
  type MerchantOutreachScope,
} from "./merchant-outreach.js";

interface Conversation {
  id: string;
  controlMode: "AI" | "HUMAN";
  controlRevision: number;
}

/** Read-only presentation; POST admission alone decides actual send eligibility. */
export async function recoveryConversationDetail(
  tx: Prisma.TransactionClient,
  conversation: Conversation | null,
  scope: Omit<MerchantOutreachScope, "conversationId">,
  attempts: readonly MerchantOutreachAttempt[],
  now: Date,
): Promise<RecoveryConversationDetail | null> {
  if (!conversation) return null;
  const evidence = resolveMerchantOutreach(
    { ...scope, conversationId: conversation.id },
    attempts,
    now,
  );
  const lastInbound = evidence.replyAnchor?.sentAt
    ? await latestVerifiedCustomerInbound(
        tx,
        conversation.id,
        evidence.replyAnchor.sentAt,
        now,
      )
    : null;
  return {
    id: conversation.id,
    controlMode: conversation.controlMode,
    controlRevision: conversation.controlRevision,
    lastInboundAt: lastInbound?.toISOString() ?? null,
    windowExpiresAt: lastInbound
      ? new Date(
          lastInbound.getTime() + CUSTOMER_SERVICE_WINDOW_MS,
        ).toISOString()
      : null,
    followUp: {
      sequence2Used: evidence.followUpUsed,
      initiatedBy: evidence.initiatedBy,
    },
  };
}

/** Missing restriction rows are ACTIVE, but an unexpected value never grants access. */
export function humanMessagingProjection(
  status: string | null,
): Pick<
  RecoveryDetailSummary,
  "humanMessagingAllowed" | "humanMessagingStatus"
> {
  if (status === null || status === "ACTIVE")
    return { humanMessagingAllowed: true, humanMessagingStatus: "ACTIVE" };
  if (status === "SUSPENDED")
    return { humanMessagingAllowed: false, humanMessagingStatus: "SUSPENDED" };
  return { humanMessagingAllowed: false, humanMessagingStatus: "SUSPENDED" };
}
