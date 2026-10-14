/** Store-local date filters and bounded, deterministic page-number pagination. */
export type RecoveryStatusFilter =
  | "all" | "ongoing" | "DETECTED" | "MESSAGE_SENT" | "ENGAGED"
  | "COMPLETED" | "EXPIRED" | "CANCELLED";
export type RecoveryPageSize = 10 | 20 | 25 | 50;

export interface RecoveryListQuery {
  from: string;
  to: string;
  timeZone: string;
  start: Date;
  end: Date;
  status: RecoveryStatusFilter;
  q: string;
  page: number;
  pageSize: RecoveryPageSize;
}

export class InvalidRecoveryListQuery extends Error {
  constructor() {
    super("invalid_request");
    this.name = "InvalidRecoveryListQuery";
  }
}

const DAY_MS = 86_400_000;
const PAGE_SIZES = new Set([10, 20, 25, 50]);
const STATUSES = new Set<RecoveryStatusFilter>([
  "all", "ongoing", "DETECTED", "MESSAGE_SENT", "ENGAGED", "COMPLETED", "EXPIRED", "CANCELLED",
]);
const PARAMETERS = new Set(["from", "to", "q", "status", "page", "pageSize"]);

function invalid(): never {
  throw new InvalidRecoveryListQuery();
}

function calendarTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value ||
    value < "0001-01-01" || value > "9998-12-31") return invalid();
  return instant;
}

function shiftCalendarDate(value: string, days: number): string {
  return new Date(calendarTimestamp(value) + days * DAY_MS).toISOString().slice(0, 10);
}

function localDate(at: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(at);
  const part = (key: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === key)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/** Find the first instant of a local calendar day, including DST transitions. */
function dayStart(value: string, formatter: Intl.DateTimeFormat): Date {
  const nominal = calendarTimestamp(value);
  let low = nominal - 2 * DAY_MS;
  let high = nominal + 2 * DAY_MS;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDate(mid, formatter) < value) low = mid + 1;
    else high = mid;
  }
  return new Date(low);
}

export function resolveRecoveryTimeZone(value: string | null): string {
  if (!value?.trim()) return "UTC";
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

export function parseRecoveryListQuery(
  params: URLSearchParams,
  timeZone: string,
  now = new Date(),
): RecoveryListQuery {
  for (const key of params.keys()) {
    if (!PARAMETERS.has(key) || params.getAll(key).length !== 1) return invalid();
  }
  const rawPage = params.get("page") ?? "1";
  const rawPageSize = params.get("pageSize") ?? "25";
  if (!/^[1-9]\d{0,3}$/.test(rawPage) || !/^(10|20|25|50)$/.test(rawPageSize)) return invalid();
  const page = Number(rawPage);
  const pageSize = Number(rawPageSize);
  if (!Number.isSafeInteger(page) || !PAGE_SIZES.has(pageSize)) return invalid();

  const status = params.get("status") ?? "all";
  if (!STATUSES.has(status as RecoveryStatusFilter)) return invalid();
  const search = params.get("q") ?? "";
  const q = search.trim();
  const codepoints = Array.from(q);
  const hasAsciiControl = codepoints.some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (search.length > 1000 || codepoints.length > 100 || hasAsciiControl) return invalid();

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const today = localDate(now.getTime(), formatter);
  const from = params.get("from") ?? shiftCalendarDate(today, -29);
  const to = params.get("to") ?? today;
  const days = (calendarTimestamp(to) - calendarTimestamp(from)) / DAY_MS + 1;
  if (days < 1 || days > 366 || to > today) return invalid();

  return {
    from, to, timeZone,
    start: dayStart(from, formatter),
    end: dayStart(shiftCalendarDate(to, 1), formatter),
    status: status as RecoveryStatusFilter,
    q, page, pageSize: pageSize as RecoveryPageSize,
  };
}
