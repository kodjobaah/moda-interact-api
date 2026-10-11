import type { PurchaseHistoryResponse } from "./contract.js";
import { WOO_ORDERS_REFUND_URL } from "./contract.js";

const FILTERS = ["ACTIVE", "WITHDRAWN", "COMPLETED", "REFUNDED", "ALL"];
const PURCHASE_STATUSES = ["REQUESTED", "ACTIVE", "WITHDRAWN", "COMPLETED", "REFUNDED"];
const REFUND_STATUSES = ["REQUESTED", "PROVIDER_ACTION_REQUIRED", "COMPLETED", "REJECTED", "CANCELLED", "NEEDS_ATTENTION"];
const UNAVAILABLE_REASONS = ["REFUND_ALREADY_ATTEMPTED", "NO_AVAILABLE_CREDITS", "PROVIDER_EVIDENCE_UNAVAILABLE", "REFUND_IN_PROGRESS"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exact(value: unknown, fields: string[]): boolean {
  const obj = record(value);
  return obj !== null && Object.keys(obj).length === fields.length && fields.every((key) => Object.hasOwn(obj, key));
}

function quantity(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function timestamp(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function money(value: unknown): boolean {
  const obj = record(value);
  return exact(value, ["amount", "currency"]) &&
    typeof obj?.amount === "string" && /^\d{1,16}(?:\.\d{1,6})?$/.test(obj.amount) &&
    typeof obj.currency === "string" && /^[A-Z]{3}$/.test(obj.currency);
}

function refund(value: unknown): boolean {
  if (!exact(value, ["status", "reason", "finalCreditQuantity", "providerAmount", "createdAt", "completedAt"])) return false;
  const obj = record(value)!;
  return REFUND_STATUSES.includes(String(obj.status)) &&
    (obj.reason === null || (typeof obj.reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(obj.reason))) &&
    (obj.finalCreditQuantity === null || quantity(obj.finalCreditQuantity)) &&
    (obj.providerAmount === null || money(obj.providerAmount)) &&
    timestamp(obj.createdAt) && (obj.completedAt === null || timestamp(obj.completedAt));
}

function purchase(value: unknown): boolean {
  const fields = ["id", "status", "createdAt", "activatedAt", "bundleLabel", "planName", "creditsGranted",
    "currentAmount", "reservedAmount", "availableAmount", "heldForRefundAmount", "refundEligible",
    "refundUnavailableReason", "refundAttempted", "latestRefund", "completedRefund", "originalProviderPurchase"];
  if (!exact(value, fields)) return false;
  const obj = record(value)!;
  return typeof obj.id === "string" && obj.id.trim().length > 0 && obj.id.length <= 128 &&
    PURCHASE_STATUSES.includes(String(obj.status)) && timestamp(obj.createdAt) &&
    (obj.activatedAt === null || timestamp(obj.activatedAt)) &&
    (obj.bundleLabel === null || (typeof obj.bundleLabel === "string" && obj.bundleLabel.length <= 120)) &&
    typeof obj.planName === "string" && obj.planName.trim().length > 0 && obj.planName.length <= 255 &&
    [obj.creditsGranted, obj.currentAmount, obj.reservedAmount, obj.availableAmount, obj.heldForRefundAmount].every(quantity) &&
    typeof obj.refundEligible === "boolean" && typeof obj.refundAttempted === "boolean" &&
    (obj.refundUnavailableReason === null || UNAVAILABLE_REASONS.includes(String(obj.refundUnavailableReason))) &&
    (obj.refundEligible === (obj.refundUnavailableReason === null)) &&
    (obj.latestRefund === null || refund(obj.latestRefund)) &&
    (obj.completedRefund === null || refund(obj.completedRefund)) &&
    (obj.originalProviderPurchase === null || money(obj.originalProviderPurchase));
}

export function isWooPurchaseHistoryResponse(value: unknown): value is PurchaseHistoryResponse {
  if (!exact(value, ["schemaVersion", "filter", "page", "pageSize", "total", "totalPages", "purchases", "refundRequest"])) return false;
  const obj = record(value)!;
  const refundRequest = record(obj.refundRequest);
  return obj.schemaVersion === 1 && FILTERS.includes(String(obj.filter)) &&
    [5, 10, 20].includes(obj.pageSize as number) &&
    quantity(obj.total) && quantity(obj.totalPages) && (obj.totalPages as number) >= 1 &&
    quantity(obj.page) && (obj.page as number) >= 1 && (obj.page as number) <= (obj.totalPages as number) &&
    Array.isArray(obj.purchases) && obj.purchases.length <= (obj.pageSize as number) && obj.purchases.every(purchase) &&
    exact(obj.refundRequest, ["method", "url"]) &&
    refundRequest?.method === "WOOCOMMERCE_ORDERS" && refundRequest.url === WOO_ORDERS_REFUND_URL;
}
