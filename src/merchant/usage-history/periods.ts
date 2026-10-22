import type { Prisma, BillingPeriodStatus } from "@prisma/client";
import { UsageHistoryRequestError, type UsageView, type UsageHistoryResponse } from "./contract.js";
import { decodePeriodCursor, encodePeriodCursor } from "./cursor.js";

export const periodSelect = {
  id: true, shopId: true, subscriptionId: true, planKindSnapshot: true,
  periodStart: true, periodEnd: true, status: true,
} as const satisfies Prisma.BillingPeriodSelect;
export type PeriodRow = Prisma.BillingPeriodGetPayload<{ select: typeof periodSelect }>;

function periodSeek(start: Date, id: string, newer: boolean): Prisma.BillingPeriodWhereInput {
  return { OR: [
    { periodStart: newer ? { gt: start } : { lt: start } },
    { periodStart: start, id: newer ? { gt: id } : { lt: id } },
  ] };
}

/** A single page with a signed, Shop-and-view-bound keyset anchor. */
export async function readPeriodPage(
  tx: Prisma.TransactionClient,
  input: { shopId: string; view: UsageView; cursor: string | null; key: Uint8Array; currentPeriod: PeriodRow | null },
): Promise<UsageHistoryResponse["periodPage"]> {
  const { shopId, view, cursor, key, currentPeriod } = input;
  if (view === "current") {
    if (cursor !== null) throw new UsageHistoryRequestError("invalid_cursor");
    return { items: currentPeriod ? [projectPeriod(currentPeriod)] : [], previousCursor: null, nextCursor: null };
  }
  const boundary = decodePeriodCursor(cursor, shopId, view, key);
  const status: BillingPeriodStatus = "CLOSED";
  if (boundary) {
    // A valid HMAC alone is not sufficient: the referenced period must still be
    // in this Shop's closed-period history with an identical sort key.
    const anchor = await tx.billingPeriod.findFirst({
      where: { shopId, status, id: boundary.id, periodStart: boundary.start },
      select: { id: true },
    });
    if (!anchor) throw new UsageHistoryRequestError("invalid_cursor");
  }
  const newer = boundary?.direction === "previous";
  const rows = await tx.billingPeriod.findMany({
    where: { shopId, status, ...(boundary ? periodSeek(boundary.start, boundary.id, newer) : {}) },
    select: periodSelect,
    orderBy: [{ periodStart: newer ? "asc" : "desc" }, { id: newer ? "asc" : "desc" }],
    take: 26,
  });
  const hasMore = rows.length > 25;
  const visible = rows.slice(0, 25);
  if (newer) visible.reverse();
  const first = visible[0];
  const last = visible.at(-1);
  return {
    items: visible.map(projectPeriod),
    previousCursor: first && (newer ? hasMore : boundary !== null)
      ? encodePeriodCursor(shopId, view, { direction: "previous", start: first.periodStart, id: first.id }, key) : null,
    nextCursor: last && (newer ? boundary !== null : hasMore)
      ? encodePeriodCursor(shopId, view, { direction: "next", start: last.periodStart, id: last.id }, key) : null,
  };
}

function projectPeriod(row: PeriodRow) {
  return { id: row.id, periodStart: row.periodStart.toISOString(), periodEnd: row.periodEnd.toISOString() };
}
