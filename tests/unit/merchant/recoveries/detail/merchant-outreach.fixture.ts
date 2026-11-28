import { createHash } from "node:crypto";
import type {
  MerchantOutreachAttempt,
  MerchantOutreachScope,
} from "../../../../../src/merchant/recoveries/detail/merchant-outreach.js";

export const scope: MerchantOutreachScope = {
  shopId: "shop-a",
  recoveryId: "recovery-a",
  conversationId: "conversation-a",
  platform: "WOOCOMMERCE",
};
export const at = new Date("2026-11-26T10:00:00.000Z");
export const now = new Date("2026-11-26T11:00:00.000Z");
export function attempt(
  sequence = 1,
  changes: Partial<MerchantOutreachAttempt> = {},
  owner = scope,
): MerchantOutreachAttempt {
  const id =
    sequence === 1
      ? "initial"
      : sequence === 2
        ? "follow-up"
        : `retry_intent-${sequence}`;
  const providerDispatchKey =
    owner.platform === "SHOPIFY"
      ? `recovery-retry-${createHash("sha256").update(id).digest("hex")}`
      : `arch046-woo-initial-${createHash("sha256").update(owner.shopId).update("\0").update(id).digest("hex")}`;
  return {
    id,
    checkoutRecoveryId: owner.recoveryId,
    sequence,
    trigger: sequence === 2 ? "NO_RESPONSE_FOLLOW_UP" : "INITIAL",
    recipient: "447700900001",
    status: "WAITING_FOR_RESPONSE",
    sentAt: at,
    followUpDueAt: at,
    initiatedBy: null,
    initiationKey: null,
    claimedAt: null,
    customerRespondedAt: null,
    outboundMessageId: `message-${sequence}`,
    outboundMessage: {
      id: `message-${sequence}`,
      conversationId: owner.conversationId,
      direction: "OUTBOUND",
      senderType: "AUTOMATION",
      status: "SENT",
      providerMessageId: `provider-${sequence}`,
      sentAt: at,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      providerDispatchKey,
      providerDispatchAdmittedAt: at,
      providerDispatchControlRevision: 0,
      dispatchProviderAccountId: "123456789123",
      dispatchProviderPhoneNumberId: "123456789124",
    },
    deliveryRetryIntent: null,
    ...changes,
  };
}
export function failed(
  sequence: number,
  nextSequence: number,
  owner = scope,
  changes: Partial<MerchantOutreachAttempt> = {},
): MerchantOutreachAttempt {
  const row = attempt(sequence, changes, owner);
  return {
    ...row,
    status: "FAILED",
    outboundMessage: {
      ...row.outboundMessage!,
      status: "FAILED",
      failedAt: at,
    },
    deliveryRetryIntent: {
      id: `intent-${nextSequence}`,
      failedAttemptId: row.id,
      failedMessageId: row.outboundMessageId!,
      cancelledAt: null,
    },
  };
}
export function delivered(
  sequence: number,
  owner = scope,
  changes: Partial<MerchantOutreachAttempt> = {},
): MerchantOutreachAttempt {
  const row = attempt(sequence, changes, owner);
  return {
    ...row,
    outboundMessage: {
      ...row.outboundMessage!,
      status: "DELIVERED",
      deliveredAt: at,
    },
  };
}
export function pendingFollowUp(owner = scope): MerchantOutreachAttempt {
  return attempt(
    2,
    {
      status: "PENDING",
      sentAt: null,
      followUpDueAt: null,
      outboundMessageId: null,
      outboundMessage: null,
    },
    owner,
  );
}
