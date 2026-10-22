import type { Prisma } from "@prisma/client";
import type { UsageChargeSource } from "./contract.js";

/** The persisted allocation, not the current subscription or the free-text
 * UsageEvent.sourceType, is authoritative for an individual credit charge. */
const reservationSelect = {
  shopId: true, status: true, committedUsageEventId: true, compensationUsageEventId: true,
  counterId: true, counter: { select: { shopId: true, counter: true } },
  billingPeriodEntitlementCounterId: true,
  billingPeriodEntitlementCounter: { select: { shopId: true, billingPeriodId: true, counter: true } },
  purchasedCreditPurchaseId: true, purchasedCreditPurchase: { select: { shopId: true } },
  promotionalCreditGrantId: true, promotionalCreditGrant: { select: { shopId: true } },
} as const satisfies Prisma.UsageReservationSelect;

type Reservation = Prisma.UsageReservationGetPayload<{ select: typeof reservationSelect }>;
type Event = {
  id: string;
  metric: string;
  billingPeriodId: string | null;
  correctionOfUsageEventId: string | null;
};

function chargeSource(row: Reservation, shopId: string, billingPeriodId: string | null): UsageChargeSource {
  if (row.shopId !== shopId || row.status !== "COMMITTED" || !row.committedUsageEventId) {
    return "UNATTRIBUTED";
  }
  const freeCounter = row.counterId !== null && row.counter?.shopId === shopId &&
    row.counter.counter === "LIFETIME_FREE_RECOVERY_CREDITS";
  const purchasedCounter = row.counterId !== null && row.counter?.shopId === shopId &&
    row.counter.counter === "PURCHASED_RECOVERY_CREDITS";
  const includedCounter = row.billingPeriodEntitlementCounterId !== null &&
    row.billingPeriodEntitlementCounter?.shopId === shopId &&
    row.billingPeriodEntitlementCounter.counter === "INCLUDED_RECOVERY_CREDITS" &&
    billingPeriodId !== null && row.billingPeriodEntitlementCounter.billingPeriodId === billingPeriodId;
  const purchase = row.purchasedCreditPurchaseId !== null && row.purchasedCreditPurchase?.shopId === shopId;
  const promotion = row.promotionalCreditGrantId !== null && row.promotionalCreditGrant?.shopId === shopId;

  if (includedCounter && row.counterId === null && row.purchasedCreditPurchaseId === null &&
      row.promotionalCreditGrantId === null) return "INCLUDED_PLAN_ALLOWANCE";
  // A purchased lot intentionally has BOTH the purchased shop counter and a lot FK.
  if (purchasedCounter && purchase && row.billingPeriodEntitlementCounterId === null &&
      row.promotionalCreditGrantId === null) return "PURCHASED_TOP_UP";
  if (promotion && row.counterId === null && row.billingPeriodEntitlementCounterId === null &&
      row.purchasedCreditPurchaseId === null) return "PROMOTIONAL_CREDITS";
  if (freeCounter && billingPeriodId === null && row.billingPeriodEntitlementCounterId === null &&
      row.purchasedCreditPurchaseId === null && row.promotionalCreditGrantId === null) {
    return "LIFETIME_FREE_CREDITS";
  }
  // Missing/reassigned lots, foreign counters and multiple contradictory sources
  // must never be presented as an inferred merchant charge.
  return "UNATTRIBUTED";
}

function append(map: Map<string, Reservation[]>, id: string | null, row: Reservation) {
  if (!id) return;
  map.set(id, [...(map.get(id) ?? []), row]);
}

/** Bounded, tenant-scoped lookup for just the current event page (at most 100).
 * Compensation and ordinary corrections inherit the ORIGINAL debit allocation.
 * Unlinked legacy/test rows remain visible but explicitly unattributed.
 */
export async function readUsageChargeSources(
  tx: Pick<Prisma.TransactionClient, "usageEvent" | "usageReservation">,
  shopId: string,
  events: readonly Event[],
): Promise<Map<string, UsageChargeSource>> {
  const result = new Map<string, UsageChargeSource>();
  if (events.length === 0) return result;
  const parentIds = [...new Set(events.flatMap((event) =>
    event.correctionOfUsageEventId ? [event.correctionOfUsageEventId] : []))];
  const parents = parentIds.length ? await tx.usageEvent.findMany({
    where: { id: { in: parentIds }, shopId, provider: "WOOCOMMERCE" },
    select: { id: true, metric: true, correctionOfUsageEventId: true, billingPeriodId: true },
  }) : [];
  const parentsById = new Map(parents.map((parent) => [parent.id, parent]));
  const evidenceIds = [...new Set([...events.map((event) => event.id), ...parents.map((parent) => parent.id)])];
  const rows = await tx.usageReservation.findMany({
    where: { shopId, OR: [
      { committedUsageEventId: { in: evidenceIds } },
      { compensationUsageEventId: { in: evidenceIds } },
    ] },
    select: reservationSelect,
  });
  const committed = new Map<string, Reservation[]>();
  const compensated = new Map<string, Reservation[]>();
  for (const row of rows) {
    append(committed, row.committedUsageEventId, row);
    append(compensated, row.compensationUsageEventId, row);
  }

  for (const event of events) {
    if (event.metric === "RECOVERY_CREDIT_PACK_PURCHASE") {
      result.set(event.id, "NOT_APPLICABLE");
      continue;
    }
    if (event.metric !== "RECOVERY_CONVERSATION") {
      result.set(event.id, "UNATTRIBUTED");
      continue;
    }
    if (event.correctionOfUsageEventId) {
      const parent = parentsById.get(event.correctionOfUsageEventId);
      const originalReservations = committed.get(event.correctionOfUsageEventId) ?? [];
      const compensationReservations = compensated.get(event.id) ?? [];
      // Reject foreign/missing parents, correction-of-correction chains and
      // compensation pointing to a different original event.
      const valid = parent?.metric === event.metric && parent.correctionOfUsageEventId === null &&
        originalReservations.length === 1 && compensationReservations.length <= 1 &&
        (compensationReservations.length === 0 || compensationReservations[0] === originalReservations[0]) &&
        (committed.get(event.id) ?? []).length === 0;
      result.set(event.id, valid
        ? chargeSource(originalReservations[0]!, shopId, parent.billingPeriodId)
        : "UNATTRIBUTED");
      continue;
    }
    const reservations = committed.get(event.id) ?? [];
    // A compensation without correction linkage is not an ordinary debit.
    result.set(event.id, reservations.length === 1 && (compensated.get(event.id) ?? []).length === 0
      ? chargeSource(reservations[0]!, shopId, event.billingPeriodId)
      : "UNATTRIBUTED");
  }
  return result;
}
