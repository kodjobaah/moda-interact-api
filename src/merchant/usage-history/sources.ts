import type { Prisma } from "@prisma/client";
import { recoverySourceFromReservationKey } from "./reservation-source-key.js";

export interface SourceRecovery {
  recoveryId: string;
  customerName: string | null;
}

export interface UsageSourceEvent {
  id: string;
  metric: string;
  sourceId: string | null;
  correctionOfUsageEventId: string | null;
  billingPeriodId: string | null;
}

type SourceDatabase = Pick<Prisma.TransactionClient,
  "usageEvent" | "usageReservation" | "checkoutRecovery" | "recoveryOutreachAttempt">;

const reservationSelect = {
  shopId: true, status: true, committedUsageEventId: true, sourceKey: true,
  billingPeriodEntitlementCounterId: true,
  billingPeriodEntitlementCounter: { select: {
    shopId: true, billingPeriodId: true, counter: true,
  } },
} as const satisfies Prisma.UsageReservationSelect;

/**
 * Resolve usage-event pages through persisted, tenant-owned evidence:
 * committed usage -> reservation -> canonical billing source -> recovery/attempt.
 * Historical direct recovery/conversation/message source IDs remain supported.
 * Corrections inherit the original debit's recovery; an unrelated source on the
 * correction is never trusted. Missing evidence is not a fabricated link, and
 * any database read failure propagates to the shared-logger HTTP boundary.
 */
export async function readUsageRecoverySources(
  tx: SourceDatabase,
  shopId: string,
  events: readonly UsageSourceEvent[],
): Promise<Map<string, SourceRecovery>> {
  const result = new Map<string, SourceRecovery>();
  if (events.length === 0) return result;
  if (events.length > 100) throw new Error("usage_source_page_overflow");

  const parentIds = [...new Set(events.flatMap((event) =>
    event.correctionOfUsageEventId ? [event.correctionOfUsageEventId] : []))];
  const parents = parentIds.length ? await tx.usageEvent.findMany({
    where: {
      id: { in: parentIds }, shopId, provider: "WOOCOMMERCE",
      metric: "RECOVERY_CONVERSATION", correctionOfUsageEventId: null,
    },
    select: { id: true, metric: true, sourceId: true, correctionOfUsageEventId: true, billingPeriodId: true },
  }) : [];
  const parentMap = new Map(parents.map((parent) => [parent.id, parent]));
  const originals = [
    ...events.filter((event) => !event.correctionOfUsageEventId),
    ...parents,
  ].filter((event) => event.metric === "RECOVERY_CONVERSATION");
  const originalIds = [...new Set(originals.map((event) => event.id))];
  if (originalIds.length === 0) return result;

  const reservations = await tx.usageReservation.findMany({
    where: { shopId, status: "COMMITTED", committedUsageEventId: { in: originalIds } },
    select: reservationSelect,
  });
  const reservationsByEvent = new Map<string, typeof reservations>();
  for (const row of reservations) {
    if (row.shopId !== shopId || row.status !== "COMMITTED" || !row.committedUsageEventId) continue;
    reservationsByEvent.set(row.committedUsageEventId,
      [...(reservationsByEvent.get(row.committedUsageEventId) ?? []), row]);
  }

  const directIds = [...new Set(originals.map((event) => event.sourceId)
    .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 191))];
  const candidateByEvent = new Map<string, { kind: "recovery" | "outreach"; id: string }>();
  for (const original of originals) {
    const rows = reservationsByEvent.get(original.id) ?? [];
    if (rows.length !== 1) continue;
    const reservation = rows[0]!;
    if (reservation.committedUsageEventId !== original.id ||
        (reservation.billingPeriodEntitlementCounterId !== null &&
          reservation.billingPeriodEntitlementCounter?.billingPeriodId !== original.billingPeriodId)) continue;
    const candidate = recoverySourceFromReservationKey(reservation, shopId);
    if (candidate) candidateByEvent.set(original.id, candidate);
  }

  const attemptIds = [...new Set([...candidateByEvent.values()]
    .filter((source) => source.kind === "outreach").map((source) => source.id))];
  const attempts = attemptIds.length ? await tx.recoveryOutreachAttempt.findMany({
    where: { id: { in: attemptIds }, checkoutRecovery: { shopId } },
    select: {
      id: true, checkoutRecoveryId: true,
      checkoutRecovery: { select: { shopId: true } },
    },
    take: 201,
  }) : [];
  if (attempts.length > 200) throw new Error("usage_source_attempt_overflow");
  const attemptsById = new Map(attempts.filter((attempt) => attempt.checkoutRecovery.shopId === shopId)
    .map((attempt) => [attempt.id, attempt.checkoutRecoveryId]));
  const recoveredIds = [...new Set([
    ...directIds,
    ...[...candidateByEvent.values()].filter((source) => source.kind === "recovery").map((source) => source.id),
    ...attemptsById.values(),
  ])];
  if (recoveredIds.length === 0) return result;

  const recoveries = await tx.checkoutRecovery.findMany({
    where: {
      shopId,
      OR: [
        { id: { in: recoveredIds } },
        { conversation: { is: { id: { in: directIds }, OR: [{ shopId }, { shopId: null }] } } },
        { conversation: { is: { messages: { some: { id: { in: directIds } } },
          OR: [{ shopId }, { shopId: null }] } } },
      ],
    },
    select: {
      id: true, shopId: true, customerId: true,
      customer: { select: { shopId: true, firstName: true, lastName: true } },
      conversation: { select: {
        id: true, shopId: true,
        messages: { where: { id: { in: directIds } }, select: { id: true } },
      } },
    },
    take: 601,
  });
  if (recoveries.length > 600) throw new Error("usage_source_result_overflow");
  const sourceById = new Map<string, SourceRecovery>();
  const collisions = new Set<string>();
  for (const recovery of recoveries) {
    if (recovery.shopId !== shopId ||
        (recovery.customerId !== null && recovery.customer?.shopId !== shopId) ||
        (recovery.conversation !== null && recovery.conversation.shopId !== null &&
          recovery.conversation.shopId !== shopId)) continue;
    const customerName = [recovery.customer?.firstName?.trim(), recovery.customer?.lastName?.trim()]
      .filter(Boolean).join(" ").slice(0, 160) || null;
    const value = { recoveryId: recovery.id, customerName };
    const ids = [recovery.id, recovery.conversation?.id,
      ...(recovery.conversation?.messages.map((message) => message.id) ?? [])];
    for (const id of ids) {
      if (!id) continue;
      if (sourceById.has(id) && sourceById.get(id)?.recoveryId !== recovery.id) collisions.add(id);
      else sourceById.set(id, value);
    }
  }
  for (const id of collisions) sourceById.delete(id);

  for (const event of events) {
    if (event.metric !== "RECOVERY_CONVERSATION") continue;
    const original = !event.correctionOfUsageEventId
      ? event : parentMap.get(event.correctionOfUsageEventId);
    if (!original) continue;
    const direct = original.sourceId ? sourceById.get(original.sourceId) : undefined;
    const candidate = candidateByEvent.get(original.id);
    const key = candidate?.kind === "outreach"
      ? attemptsById.get(candidate.id) : candidate?.id;
    const canonical = key ? sourceById.get(key) : undefined;
    // Contradictory persisted direct and reservation-derived recovery evidence
    // must not become a confidently linked customer/recovery in the response.
    if (direct && canonical && direct.recoveryId !== canonical.recoveryId) continue;
    const resolved = canonical ?? direct;
    if (resolved) result.set(event.id, resolved);
  }
  return result;
}
