import type { RecoveryListResponse } from "./contract.js";

const STATUSES = new Set(["DETECTED", "MESSAGE_SENT", "ENGAGED", "COMPLETED", "EXPIRED", "CANCELLED"]);
const FILTERS = new Set(["all", "ongoing", ...STATUSES]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exact(value: unknown, fields: readonly string[]): boolean {
  const row = object(value);
  return row !== null && Object.keys(row).length === fields.length && fields.every((key) => Object.hasOwn(row, key));
}

function dateTime(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function optionalText(value: unknown, maxLength: number): boolean {
  return value === null || (typeof value === "string" && value.length <= maxLength);
}

function item(value: unknown): boolean {
  if (!exact(value, ["id", "status", "detectedAt", "lastActivityAt", "totalPrice", "currency", "customer"])) return false;
  const row = object(value)!;
  if (typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,191}$/.test(row.id) ||
    !STATUSES.has(String(row.status)) || !dateTime(row.detectedAt) || !dateTime(row.lastActivityAt) ||
    !(row.totalPrice === null || (typeof row.totalPrice === "string" && /^-?\d{1,40}(?:\.\d{1,30})?$/.test(row.totalPrice))) ||
    !(row.currency === null || (typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency)))) return false;
  if (row.customer === null) return true;
  return exact(row.customer, ["displayName", "email"]) &&
    optionalText(object(row.customer)?.displayName, 160) && optionalText(object(row.customer)?.email, 320);
}

export function isRecoveryListResponse(value: unknown): value is RecoveryListResponse {
  const fields = ["schemaVersion", "timeZone", "from", "to", "q", "status", "page", "pageSize",
    "total", "totalPages", "hasPrevious", "hasNext", "items"];
  if (!exact(value, fields)) return false;
  const row = object(value)!;
  const page = row.page as number;
  const totalPages = row.totalPages as number;
  const total = row.total as number;
  const pageSize = row.pageSize as number;
  return row.schemaVersion === 1 &&
    typeof row.timeZone === "string" && row.timeZone.length > 0 && row.timeZone.length <= 255 &&
    typeof row.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.from) &&
    typeof row.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.to) &&
    typeof row.q === "string" && Array.from(row.q).length <= 100 &&
    FILTERS.has(String(row.status)) &&
    Number.isSafeInteger(page) && page >= 1 &&
    [10, 20, 25, 50].includes(pageSize) &&
    Number.isSafeInteger(total) && total >= 0 &&
    Number.isSafeInteger(totalPages) && totalPages === Math.max(1, Math.ceil(total / pageSize)) &&
    page <= totalPages &&
    row.hasPrevious === (page > 1) && row.hasNext === (page < totalPages) &&
    Array.isArray(row.items) && row.items.length <= pageSize && row.items.every(item);
}
