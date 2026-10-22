import { UsageMetric } from "@prisma/client";
import type { UsageHistoryResponse } from "./contract.js";

const ID = /^[A-Za-z0-9_-]{1,191}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,1024}$/;
const METRICS = new Set<string>(Object.values(UsageMetric));

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function exact(value: unknown, keys: readonly string[]): boolean {
  const row = object(value);
  return row !== null && Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
}
function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function finiteQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}
function source(value: unknown): boolean {
  if (value === null) return true;
  if (!exact(value, ["recoveryId", "customerName"])) return false;
  const item = object(value)!;
  return id(item.recoveryId) && (item.customerName === null ||
    (typeof item.customerName === "string" && item.customerName.length > 0 && item.customerName.length <= 160));
}

/** Tight DTO boundary: no idempotency keys, provider handles or extra metadata. */
export function isUsageHistoryResponse(value: unknown): value is UsageHistoryResponse {
  if (!exact(value, ["schemaVersion", "state", "usageView", "periodPage", "usageEvents", "usagePagination"])) return false;
  const result = object(value)!;
  if (result.schemaVersion !== 1 || !["ready", "unavailable"].includes(String(result.state)) ||
      !["current", "past"].includes(String(result.usageView))) return false;
  const periods = object(result.periodPage);
  if (!exact(periods, ["items", "previousCursor", "nextCursor"]) || !Array.isArray(periods?.items) ||
      periods.items.length > 25 || !periods.items.every((period) => {
        if (!exact(period, ["id", "periodStart", "periodEnd"])) return false;
        const item = object(period)!;
        return id(item.id) && date(item.periodStart) && date(item.periodEnd) && item.periodStart < item.periodEnd;
      })) return false;
  for (const cursor of [periods.previousCursor, periods.nextCursor]) {
    if (cursor !== null && (typeof cursor !== "string" || !CURSOR.test(cursor))) return false;
  }
  const paging = object(result.usagePagination);
  if (!exact(paging, ["page", "pageSize", "total", "totalQuantity", "billId", "periodStart", "periodEnd"]) ||
      !count(paging?.page) || paging.page < 1 || paging.page > 1000 ||
      ![10, 25, 50, 100].includes(paging.pageSize as number) ||
      !count(paging.total) || !finiteQuantity(paging.totalQuantity) ||
      !(paging.billId === null || id(paging.billId)) ||
      !(paging.periodStart === null || date(paging.periodStart)) ||
      !(paging.periodEnd === null || date(paging.periodEnd)) ||
      ((paging.billId === null) !== (paging.periodStart === null)) ||
      ((paging.billId === null) !== (paging.periodEnd === null)) ||
      (typeof paging.periodStart === "string" && typeof paging.periodEnd === "string" &&
        paging.periodStart >= paging.periodEnd)) return false;
  if (!Array.isArray(result.usageEvents) || result.usageEvents.length > (paging.pageSize as number) ||
      result.usageEvents.length > (paging.total as number)) return false;
  if (!result.usageEvents.every((event) => {
    if (!exact(event, ["id", "metric", "quantity", "occurredAt", "sourceRecovery"])) return false;
    const item = object(event)!;
    return id(item.id) && METRICS.has(String(item.metric)) && finiteQuantity(item.quantity) &&
      date(item.occurredAt) && source(item.sourceRecovery);
  })) return false;
  if (result.state === "unavailable" &&
      (result.usageEvents.length > 0 || paging.billId !== null || paging.total !== 0)) return false;
  return true;
}
