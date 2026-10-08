import type { BillingPresentationResponse } from "./billing-read.service.js";
import type { BillingPlanCatalogueResponse } from "./plan-catalogue-read.service.js";

const EXPERIENCE_STATES = ["ACTIVE", "NO_CONTRACT", "FROZEN", "BILLING_ATTENTION"] as const;
const PLAN_KINDS = ["FREE", "PAID_METERED"] as const;
const BILLING_PERIODS = ["EVERY_30_DAYS"] as const;
const ALLOWANCE_PERIODS = ["LIFETIME", "EVERY_30_DAYS"] as const;
const OPERATION_STATES = ["INITIATING", "AWAITING_CONFIRMATION", "OUTCOME_UNKNOWN", "CONFIRMED"] as const;
const PURCHASE_OPERATION_STATES = [...OPERATION_STATES, "FAILED"] as const;
const PURCHASE_STATUSES = ["REQUESTED", "ACTIVE", "COMPLETED", "WITHDRAWN", "REFUNDED"] as const;

export const BILLING_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "billing_not_initialized",
  "billing_integrity_invalid",
  "billing_catalogue_mapping_invalid",
  "billing_operation_conflict",
  "billing_catalogue_invalid",
  "billing_catalogue_translation_unavailable",
  "billing_locale_invalid",
  "internal_error",
] as const;

export interface BillingErrorResponse {
  error: (typeof BILLING_ERROR_CODES)[number];
}

export function isBillingPresentationResponse(value: unknown): value is BillingPresentationResponse {
  if (!hasExactKeys(value, [
    "schemaVersion", "experienceState", "surfaces", "currentPlan", "pendingPlan",
    "pendingCancellation", "capacity", "topUps",
  ])) return false;
  const response = record(value);
  if (response.schemaVersion !== 1 || !oneOf(response.experienceState, EXPERIENCE_STATES)) return false;
  if (!hasExactKeys(response.surfaces, [
    "usageHistoryAllowed", "purchaseHistoryAllowed", "managePlansAllowed", "cancelSubscriptionAllowed",
  ])) return false;
  const surfaces = record(response.surfaces);
  if (!Object.values(surfaces).every((entry) => typeof entry === "boolean")) return false;
  if (!isCurrentPlan(response.currentPlan) || !isPendingPlan(response.pendingPlan) ||
      !isPendingCancellation(response.pendingCancellation)) return false;

  if (!hasExactKeys(response.capacity, ["paidIncluded", "freeLifetime", "promotional", "purchased"])) return false;
  const capacity = record(response.capacity);
  if (capacity.paidIncluded !== null && !isPaidIncluded(capacity.paidIncluded)) return false;
  if (!isBalance(capacity.freeLifetime) || !isBalance(capacity.promotional) || !isPurchasedBalance(capacity.purchased)) return false;

  if (!hasExactKeys(response.topUps, ["configured", "purchaseEligible", "offers", "latestPurchase", "unresolvedPurchases"])) return false;
  const topUps = record(response.topUps);
  return typeof topUps.configured === "boolean" && typeof topUps.purchaseEligible === "boolean" &&
    Array.isArray(topUps.offers) && topUps.offers.every(isTopUpOffer) &&
    (topUps.latestPurchase === null || isPurchase(topUps.latestPurchase)) &&
    Array.isArray(topUps.unresolvedPurchases) && topUps.unresolvedPurchases.every(isPurchase);
}

export function isBillingPlanCatalogueResponse(value: unknown): value is BillingPlanCatalogueResponse {
  if (!hasExactKeys(value, ["schemaVersion", "resolvedLocale", "plans"])) return false;
  const response = record(value);
  return response.schemaVersion === 1 && boundedString(response.resolvedLocale, 64) &&
    Array.isArray(response.plans) && response.plans.every(isPlan);
}

export function isBillingErrorResponse(value: unknown): value is BillingErrorResponse {
  if (!hasExactKeys(value, ["error"])) return false;
  return (BILLING_ERROR_CODES as readonly unknown[]).includes(record(value).error);
}

function isCurrentPlan(value: unknown): boolean {
  if (value === null) return true;
  if (!hasExactKeys(value, [
    "merchantPricingPlanId", "displayName", "planKind", "recurringAmountMinor", "currency",
    "billingPeriod", "currentPeriodEnd", "cancelAtPeriodEnd", "cancellationEffectiveAt",
  ])) return false;
  const plan = record(value);
  return boundedString(plan.merchantPricingPlanId, 128) && boundedString(plan.displayName, 255) &&
    oneOf(plan.planKind, PLAN_KINDS) && nonNegativeInteger(plan.recurringAmountMinor) &&
    isCurrency(plan.currency) && oneOf(plan.billingPeriod, BILLING_PERIODS) &&
    nullableIsoDateTime(plan.currentPeriodEnd) && typeof plan.cancelAtPeriodEnd === "boolean" &&
    nullableIsoDateTime(plan.cancellationEffectiveAt);
}

function isPendingPlan(value: unknown): boolean {
  if (value === null) return true;
  if (!hasExactKeys(value, [
    "merchantPricingPlanId", "displayName", "recurringAmountMinor", "currency", "billingPeriod", "state",
  ])) return false;
  const plan = record(value);
  return boundedString(plan.merchantPricingPlanId, 128) && boundedString(plan.displayName, 255) &&
    nonNegativeInteger(plan.recurringAmountMinor) && isCurrency(plan.currency) &&
    oneOf(plan.billingPeriod, BILLING_PERIODS) &&
    ["INITIATING", "AWAITING_CONFIRMATION", "OUTCOME_UNKNOWN"].includes(String(plan.state));
}

function isPendingCancellation(value: unknown): boolean {
  return value === null || (hasExactKeys(value, ["state"]) && oneOf(record(value).state, OPERATION_STATES));
}

function isBalance(value: unknown): boolean {
  if (!hasExactKeys(value, ["granted", "committed", "reserved", "remaining"])) return false;
  const balance = record(value);
  return [balance.granted, balance.committed, balance.reserved, balance.remaining].every(nonNegativeInteger);
}

function isPaidIncluded(value: unknown): boolean {
  if (!hasExactKeys(value, ["granted", "currentAllowance", "committed", "reserved", "forfeited", "remaining"])) return false;
  const balance = record(value);
  return [balance.granted, balance.currentAllowance, balance.committed, balance.reserved,
    balance.forfeited, balance.remaining].every(nonNegativeInteger);
}

function isPurchasedBalance(value: unknown): boolean {
  if (!hasExactKeys(value, ["granted", "committed", "reserved", "refunding", "available"])) return false;
  const balance = record(value);
  return [balance.granted, balance.committed, balance.reserved, balance.refunding, balance.available].every(nonNegativeInteger);
}

function isTopUpOffer(value: unknown): boolean {
  if (!hasExactKeys(value, [
    "merchantPricingUsageEventId", "label", "creditsGranted", "amountMinor", "currency",
    "purchaseEligible", "unavailableReason",
  ])) return false;
  const offer = record(value);
  return boundedString(offer.merchantPricingUsageEventId, 128) && boundedString(offer.label, 120) &&
    positiveInteger(offer.creditsGranted) && positiveInteger(offer.amountMinor) && offer.currency === "USD" &&
    typeof offer.purchaseEligible === "boolean" &&
    (offer.unavailableReason === null || offer.unavailableReason === "PENDING_PURCHASE");
}

function isPurchase(value: unknown): boolean {
  if (!hasExactKeys(value, [
    "id", "status", "merchantPricingUsageEventId", "label", "creditsGranted", "currentAmount",
    "reservedAmount", "createdAt", "activatedAt", "operationState",
  ])) return false;
  const purchase = record(value);
  return boundedString(purchase.id, 128) && oneOf(purchase.status, PURCHASE_STATUSES) &&
    boundedString(purchase.merchantPricingUsageEventId, 128) &&
    boundedString(purchase.label, 120) && nonNegativeInteger(purchase.creditsGranted) &&
    nonNegativeInteger(purchase.currentAmount) && nonNegativeInteger(purchase.reservedAmount) &&
    isoDateTime(purchase.createdAt) && nullableIsoDateTime(purchase.activatedAt) &&
    oneOf(purchase.operationState, PURCHASE_OPERATION_STATES);
}

function isPlan(value: unknown): boolean {
  if (!hasExactKeys(value, [
    "merchantPricingPlanId", "displayName", "planKind", "cataloguePosition", "featured",
    "localizedDescription", "includedRecoveryCredits", "allowancePeriod", "billingPeriod",
    "recurringAmountMinor", "currency", "highlights",
  ])) return false;
  const plan = record(value);
  return boundedString(plan.merchantPricingPlanId, 128) && boundedString(plan.displayName, 255) &&
    oneOf(plan.planKind, PLAN_KINDS) && nonNegativeInteger(plan.cataloguePosition) &&
    typeof plan.featured === "boolean" && boundedString(plan.localizedDescription, 2000) &&
    nonNegativeInteger(plan.includedRecoveryCredits) && oneOf(plan.allowancePeriod, ALLOWANCE_PERIODS) &&
    oneOf(plan.billingPeriod, BILLING_PERIODS) && nonNegativeInteger(plan.recurringAmountMinor) &&
    isCurrency(plan.currency) && Array.isArray(plan.highlights) && plan.highlights.every(isHighlight);
}

function isHighlight(value: unknown): boolean {
  if (!hasExactKeys(value, ["contentKey", "position", "title", "description"])) return false;
  const highlight = record(value);
  return boundedString(highlight.contentKey, 128) && nonNegativeInteger(highlight.position) &&
    boundedString(highlight.title, 120) && boundedString(highlight.description, 2000);
}

function hasExactKeys(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return (values as readonly unknown[]).includes(value);
}

function isCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

function nullableIsoDateTime(value: unknown): boolean {
  return value === null || isoDateTime(value);
}

function isoDateTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}