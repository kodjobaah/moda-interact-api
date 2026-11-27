import type { Prisma } from "@prisma/client";
import { MAX_OUTREACH_HISTORY, projectRecoveryOutreach, type RecoveryOutreachProjection } from "./outreach-projection.js";
import { RecoveryDetailIntegrityError } from "./contracts.js";

const attemptSelect = {
  id: true, checkoutRecoveryId: true, sequence: true, trigger: true, recipient: true,
  initiatedBy: true, status: true, sentAt: true, customerRespondedAt: true,
  outboundMessageId: true, failureCode: true,
  outboundMessage: { select: {
    id: true, conversationId: true, direction: true, senderType: true, status: true,
    providerMessageId: true, providerDispatchKey: true, providerDispatchAdmittedAt: true,
    providerFailureCode: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true,
  } },
  deliveryRetryIntent: { select: {
    id: true, failedAttemptId: true, failedMessageId: true, cancelledAt: true,
    policy: true, notBeforeAt: true, expectedGeneration: true, expectedLastExternalActivityAt: true,
  } },
} as const satisfies Prisma.RecoveryOutreachAttemptSelect;

/** Caller has already authenticated and verified recovery/conversation ownership
 * in this same repeatable-read transaction. No writer or provider is invoked. */
export async function readRecoveryOutreach(tx: Prisma.TransactionClient, input: {
  shopId: string;
  recoveryId: string;
  conversationId: string | null;
  generation: number;
  lastExternalActivityAt: Date;
}): Promise<RecoveryOutreachProjection> {
  const attempts = await tx.recoveryOutreachAttempt.findMany({
    where: { checkoutRecoveryId: input.recoveryId, checkoutRecovery: { shopId: input.shopId } },
    orderBy: { sequence: "asc" }, take: MAX_OUTREACH_HISTORY + 1, select: attemptSelect,
  });
  const projection = projectRecoveryOutreach({ ...input, attempts });
  if (!projection) throw new RecoveryDetailIntegrityError();
  return projection;
}
