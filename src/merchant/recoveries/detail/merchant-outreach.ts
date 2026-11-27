import { createHash } from "node:crypto";
import { hasConfirmedOutreachDelivery, selectEffectiveOutreachAttempt,
  type OutreachAttemptIdentity, type OutreachMessageIdentity } from "./outreach-lineage.js";
import { MAX_OUTREACH_HISTORY } from "./outreach-projection.js";

export type MerchantOutreachAttempt = Omit<OutreachAttemptIdentity, "initiatedBy" | "outboundMessage"> & {
  initiatedBy: "HUMAN" | "AGENT" | "AUTOMATION" | null;
  initiationKey: string | null;
  claimedAt: Date | null;
  followUpDueAt: Date | null;
  outboundMessage: (OutreachMessageIdentity & {
    providerDispatchKey: string | null;
    providerDispatchAdmittedAt: Date | null;
    providerDispatchControlRevision: number | null;
    dispatchProviderAccountId: string | null;
    dispatchProviderPhoneNumberId: string | null;
  }) | null;
};
export type MerchantOutreachScope = {
  shopId: string; recoveryId: string; conversationId: string;
  platform: "SHOPIFY" | "WOOCOMMERCE";
};

function ownsOutbound(attempt: MerchantOutreachAttempt, conversationId: string): boolean {
  const message = attempt.outboundMessage;
  return !!message && message.id === attempt.outboundMessageId &&
    message.conversationId === conversationId && message.direction === "OUTBOUND" &&
    message.senderType === "AUTOMATION";
}

/** Match the Background's historical initial-retry receipt fence. A positive
 * callback must identify the exact admitted physical send and historical sender,
 * not merely a higher sequence or a message bearing a provider ID. */
function confirmedRetry(scope: MerchantOutreachScope, chain: readonly MerchantOutreachAttempt[],
  current: MerchantOutreachAttempt): boolean {
  const message = current.outboundMessage;
  if (!message || !hasConfirmedOutreachDelivery(current, scope.conversationId) || message.failedAt ||
      !message.providerDispatchAdmittedAt || message.providerDispatchControlRevision === null ||
      !message.sentAt || message.sentAt.getTime() !== current.sentAt?.getTime() ||
      !message.dispatchProviderAccountId || !message.dispatchProviderPhoneNumberId) return false;
  const key = scope.platform === "SHOPIFY"
    ? `recovery-retry-${createHash("sha256").update(current.id).digest("hex")}`
    : `arch046-woo-initial-${createHash("sha256").update(scope.shopId).update("\0").update(current.id).digest("hex")}`;
  return message.providerDispatchKey === key && chain.slice(0, -1).every(attempt =>
    attempt.outboundMessage?.dispatchProviderAccountId === message.dispatchProviderAccountId &&
    attempt.outboundMessage?.dispatchProviderPhoneNumberId === message.dispatchProviderPhoneNumberId);
}

export function unusedFollowUp(attempt: MerchantOutreachAttempt): boolean {
  return attempt.sequence === 2 && attempt.status === "PENDING" && attempt.initiatedBy === null &&
    attempt.initiationKey === null && attempt.claimedAt === null && attempt.outboundMessageId === null &&
    attempt.sentAt === null && attempt.deliveryRetryIntent === null;
}

/** Separate verified customer-service contact from permission for proactive
 * outreach. A failed initial delivery cannot supply a new offer promise, but
 * a verified inbound after its historical send may still open a reply window.
 * The single logical follow-up slot belongs to sequence two even when a
 * successor has its own physical sequence, message, reservation and allowance.
 */
export function resolveMerchantOutreach(scope: MerchantOutreachScope,
  attempts: readonly MerchantOutreachAttempt[], now: Date) {
  const unavailable = { replyAnchor: null, initial: null, followUpUsed: true, initiatedBy: null } as const;
  if (attempts.length > MAX_OUTREACH_HISTORY || !Number.isFinite(now.getTime()) ||
      attempts.some(attempt => attempt.checkoutRecoveryId !== scope.recoveryId)) return unavailable;
  const originals = attempts.filter(attempt => attempt.sequence === 1 && attempt.trigger === "INITIAL");
  const original = originals.length === 1 ? originals[0] : undefined;
  const validTime = (date: Date | null): date is Date => !!date && Number.isFinite(date.getTime()) && date <= now;
  // Keep the original service-window anchor (including legacy attempts lacking
  // a linked message); actual inbound evidence remains mandatory for HUMAN_TEXT.
  const replyAnchor = original && validTime(original.sentAt) &&
    (!original.outboundMessageId || ownsOutbound(original, scope.conversationId)) ? original : null;
  const initialSelection = selectEffectiveOutreachAttempt({ ...scope, slot: "INITIAL", attempts });
  let initial: MerchantOutreachAttempt | null = null;
  if (initialSelection.kind === "selected") {
    const current = initialSelection.current;
    const message = current.outboundMessage;
    if (validTime(current.sentAt) && ownsOutbound(current, scope.conversationId) && message?.providerMessageId &&
        ["SENT", "DELIVERED", "READ"].includes(message.status) &&
        (!current.deliveryRetryIntent || current.deliveryRetryIntent.cancelledAt !== null) &&
        (current.status !== "FAILED" || hasConfirmedOutreachDelivery(current, scope.conversationId)) &&
        (initialSelection.retryCount === 0 || confirmedRetry(scope, initialSelection.chain, current))) initial = current;
  }
  const followUp = selectEffectiveOutreachAttempt({ ...scope, slot: "FOLLOW_UP", attempts });
  return {
    replyAnchor: replyAnchor ?? initial, initial,
    followUpUsed: followUp.kind === "conflict" || (followUp.kind === "selected" &&
      (followUp.retryCount !== 0 || !unusedFollowUp(followUp.original))),
    initiatedBy: followUp.kind === "selected" ? followUp.original.initiatedBy : null,
  };
}
