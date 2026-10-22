export const USAGE_HISTORY_PATH = "/v1/merchant/usage-history";

export type UsageView = "current" | "past";
export type UsageKind = "ALL" | "RECOVERY_CONVERSATION";
export type UsagePageSize = 10 | 25 | 50 | 100;

export interface UsageHistoryQuery {
  view: UsageView;
  periodId: string | null;
  kind: UsageKind;
  page: number;
  pageSize: UsagePageSize;
  periodCursor: string | null;
}

export interface UsageHistoryResponse {
  schemaVersion: 1;
  state: "ready" | "unavailable";
  usageView: UsageView;
  periodPage: {
    items: Array<{ id: string; periodStart: string; periodEnd: string }>;
    previousCursor: string | null;
    nextCursor: string | null;
  };
  usageEvents: Array<{
    id: string;
    metric: string;
    quantity: number;
    occurredAt: string;
    sourceRecovery: { recoveryId: string; customerName: string | null } | null;
  }>;
  usagePagination: {
    page: number;
    pageSize: UsagePageSize;
    total: number;
    totalQuantity: number;
    billId: string | null;
    periodStart: string | null;
    periodEnd: string | null;
  };
}

export class UsageHistoryRequestError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_cursor" | "invalid_period") {
    super(code);
    this.name = "UsageHistoryRequestError";
  }
}

export class UsageHistoryIntegrityError extends Error {
  constructor() {
    super("usage_history_integrity_invalid");
    this.name = "UsageHistoryIntegrityError";
  }
}

const PERIOD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,1024}$/;
const PARAMETERS = new Set(["view", "periodId", "kind", "page", "pageSize", "periodCursor"]);

export function validUsagePeriodId(value: unknown): value is string {
  return typeof value === "string" && PERIOD_ID.test(value);
}

export function parseUsageHistoryQuery(params: URLSearchParams): UsageHistoryQuery {
  for (const name of params.keys()) {
    if (!PARAMETERS.has(name) || params.getAll(name).length !== 1) {
      throw new UsageHistoryRequestError("invalid_request");
    }
  }
  const view = params.get("view") ?? "current";
  const kind = params.get("kind") ?? "ALL";
  const page = params.get("page") ?? "1";
  const pageSize = params.get("pageSize") ?? "10";
  const periodId = params.get("periodId");
  const periodCursor = params.get("periodCursor");
  if ((view !== "current" && view !== "past") || (kind !== "ALL" && kind !== "RECOVERY_CONVERSATION") ||
      !/^(?:[1-9]|[1-9]\d{1,2}|1000)$/.test(page) || Number(page) > 1000 ||
      !["10", "25", "50", "100"].includes(pageSize) ||
      (periodId !== null && !validUsagePeriodId(periodId)) ||
      (periodCursor !== null && !CURSOR.test(periodCursor))) {
    throw new UsageHistoryRequestError("invalid_request");
  }
  return {
    view, kind, page: Number(page), pageSize: Number(pageSize) as UsagePageSize,
    periodId, periodCursor,
  };
}
