import type { Prisma } from "@prisma/client";
import { SendHttpError } from "./contract.js";

/** Match Background's recovery-scope entitlement semantics; never mistake
 * RECOVERY_HISTORY read visibility for SEND entitlement. */
export async function requireRecoveryExecution(tx: Prisma.TransactionClient, shopId: string,
  onboardingCompleted: boolean): Promise<void> {
  const subscription = await tx.subscription.findUnique({ where: { shopId }, select: {
    status: true, lastProviderLifecycleState: true, planId: true,
    plan: { select: { active: true, features: {
      where: { enabled: true, feature: { is: { key: "checkout_recovery", active: true,
        activationMode: "ALWAYS_ENABLED" } } }, select: { id: true },
    } } },
  } });
  if (!subscription || ["SYNC_ERROR", "UNMAPPED"].includes(subscription.status))
    throw new SendHttpError(409, "send_entitlement_unavailable");
  if (subscription.status === "NO_CONTRACT") {
    // A verified ended contract can continue using durable purchased credits;
    // credit admission itself still belongs to Background.
    if (!(subscription.lastProviderLifecycleState === "CANCELED" && onboardingCompleted))
      throw new SendHttpError(409, "send_entitlement_unavailable");
    return;
  }
  // A read-only RECOVERY_HISTORY permission is not a send entitlement.
  // Require the active plan's Checkout Recovery feature independently.
  if (!subscription.planId || !subscription.plan?.active || subscription.plan.features.length !== 1)
    throw new SendHttpError(409, "send_entitlement_unavailable");
  // Background permits WooCommerce FROZEN subscriptions under recovery scope.
}

/** A HUMAN reply needs a verified actual customer inbound after initial outreach.
 * Conversation.lastInboundAt alone is not authoritative evidence. */
export async function latestVerifiedCustomerInbound(tx: Prisma.TransactionClient, conversationId: string,
  initialSentAt: Date, now: Date): Promise<Date | null> {
  const message = await tx.conversationMessage.findFirst({
    where: { conversationId, direction: "INBOUND", senderType: "CUSTOMER",
      providerMessageId: { not: null }, createdAt: { gte: initialSentAt, lte: now } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true },
  });
  return message?.createdAt ?? null;
}

export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export function windowOpen(at: Date | null, now: Date): boolean {
  return at !== null && at.getTime() <= now.getTime() && now.getTime() < at.getTime() + CUSTOMER_SERVICE_WINDOW_MS;
}
/** The scheduled follow-up may impose a later, frozen due time. */
export function configuredFollowUpDue(followUpDueAt: Date | null, now: Date): boolean {
  return followUpDueAt !== null && Number.isFinite(followUpDueAt.getTime()) &&
    followUpDueAt.getTime() <= now.getTime();
}

/** Manual outreach has its own slot after 24 hours of silence, even when
 * no automated follow-up was scheduled. An older configured post-window
 * template still requires its saved due time after a customer has engaged. */
export function merchantFollowUpDue(initialSentAt: Date, scheduledDueAt: Date | null,
  verifiedInboundAt: Date | null, now: Date): boolean {
  if (!(now.getTime() - initialSentAt.getTime() >= CUSTOMER_SERVICE_WINDOW_MS)) return false;
  if (scheduledDueAt) return configuredFollowUpDue(scheduledDueAt, now);
  return verifiedInboundAt === null;
}
