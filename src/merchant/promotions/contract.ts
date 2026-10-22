/** API-021: versioned, Woo-installation-scoped promotional recovery-credit contract. */
export const PROMOTIONS_PATH = "/v1/merchant/promotions";
export const PROMOTION_SELECTION_PATH = `${PROMOTIONS_PATH}/selection`;
export const PROMOTION_PAGE_SIZE = 6;
export const MAX_PROMOTION_PAGE = 1000;
export const MAX_PROMOTION_BODY_BYTES = 4096;

export type PromotionHistoryStatus =
  | "SELECTED" | "USED" | "EXHAUSTED" | "EXPIRED" | "CLOSED" | "NO_LONGER_ELIGIBLE" | "REOPENED";

export interface PromotionOffer {
  id: string;
  merchantTitle: string;
  merchantDescription: string;
  quantity: number;
  expiresAt: string;
  remainingQuantity: number;
  exhausted: boolean;
  previouslyClaimed: boolean;
  currentlySelected: boolean;
  eligible: boolean;
  selectable: boolean;
}

export interface PromotionSelection {
  campaignId: string;
  merchantTitle: string;
  remainingQuantity: number;
  quantityGranted: number;
  reservedQuantity: number;
  committedQuantity: number;
  expiresAt: string;
  locked: boolean;
  exhausted: boolean;
  campaignStatus: "DRAFT" | "ACTIVE" | "CLOSED";
  targetEligible: boolean;
  spendable: boolean;
}

export interface PromotionHistoryEntry {
  campaignId: string;
  campaignTitle: string;
  status: PromotionHistoryStatus;
  quantityGranted: number;
  committedQuantity: number;
  remainingQuantity: number;
  lastSelectedAt: string | null;
  expiresAt: string;
}

export interface PromotionPagination {
  page: number;
  pageSize: 6;
  totalEntries: number;
  totalPages: number;
}

export interface PromotionReadResponse {
  schemaVersion: 1;
  revision: string;
  offers: PromotionOffer[];
  offersPagination: PromotionPagination;
  selection: PromotionSelection | null;
  history: PromotionPagination & { entries: PromotionHistoryEntry[] };
}

export interface PromotionSelectionResponse {
  schemaVersion: 1;
  revision: string;
  selection: PromotionSelection;
}

export interface PromotionSelectionRequest {
  campaignId: string;
  expectedRevision: string;
}

export class PromotionRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: "invalid_request" | "request_too_large") {
    super(code);
  }
}

export class PromotionDomainError extends Error {
  constructor(readonly status: 409 | 422, readonly code:
    "promotion_unavailable" | "promotion_revision_conflict" | "promotion_selection_locked" |
    "promotion_not_eligible" | "promotion_exhausted" | "promotion_integrity_invalid") {
    super(code);
  }
}

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const revisionPattern = /^[a-f0-9]{64}$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const iso = (value: unknown): value is string => typeof value === "string" && isoPattern.test(value) && !Number.isNaN(Date.parse(value));

export function parsePromotionSelection(input: unknown): PromotionSelectionRequest {
  if (!record(input) || !exactKeys(input, ["campaignId", "expectedRevision"]) ||
    typeof input.campaignId !== "string" || !idPattern.test(input.campaignId) ||
    typeof input.expectedRevision !== "string" || !revisionPattern.test(input.expectedRevision)) {
    throw new PromotionRequestError(400, "invalid_request");
  }
  return { campaignId: input.campaignId, expectedRevision: input.expectedRevision };
}

function validPagination(input: unknown): input is PromotionPagination {
  return record(input) && count(input.page) && input.page >= 1 && input.page <= MAX_PROMOTION_PAGE &&
    input.pageSize === PROMOTION_PAGE_SIZE && count(input.totalEntries) &&
    count(input.totalPages) && input.totalPages === Math.max(1, Math.ceil(input.totalEntries / PROMOTION_PAGE_SIZE));
}

function validSelection(value: unknown): value is PromotionSelection {
  if (!record(value) || !exactKeys(value, ["campaignId", "merchantTitle", "remainingQuantity", "quantityGranted",
    "reservedQuantity", "committedQuantity", "expiresAt", "locked", "exhausted", "campaignStatus",
    "targetEligible", "spendable"])) return false;
  return typeof value.campaignId === "string" && idPattern.test(value.campaignId) &&
    typeof value.merchantTitle === "string" && value.merchantTitle.length > 0 && value.merchantTitle.length <= 255 &&
    count(value.remainingQuantity) && count(value.quantityGranted) && count(value.reservedQuantity) &&
    count(value.committedQuantity) &&
    value.reservedQuantity + value.committedQuantity + value.remainingQuantity === value.quantityGranted &&
    iso(value.expiresAt) && typeof value.locked === "boolean" && typeof value.exhausted === "boolean" &&
    ["DRAFT", "ACTIVE", "CLOSED"].includes(String(value.campaignStatus)) &&
    typeof value.targetEligible === "boolean" && typeof value.spendable === "boolean";
}

function validOffer(value: unknown): value is PromotionOffer {
  if (!record(value) || !exactKeys(value, ["id", "merchantTitle", "merchantDescription", "quantity", "expiresAt",
    "remainingQuantity", "exhausted", "previouslyClaimed", "currentlySelected", "eligible", "selectable"])) return false;
  return typeof value.id === "string" && idPattern.test(value.id) &&
    typeof value.merchantTitle === "string" && value.merchantTitle.length > 0 && value.merchantTitle.length <= 255 &&
    typeof value.merchantDescription === "string" && value.merchantDescription.length <= 10000 &&
    count(value.quantity) && count(value.remainingQuantity) && value.remainingQuantity <= value.quantity &&
    iso(value.expiresAt) && ["exhausted", "previouslyClaimed", "currentlySelected", "eligible", "selectable"]
      .every((key) => typeof value[key] === "boolean");
}

function validHistoryEntry(value: unknown): value is PromotionHistoryEntry {
  if (!record(value) || !exactKeys(value, ["campaignId", "campaignTitle", "status", "quantityGranted",
    "committedQuantity", "remainingQuantity", "lastSelectedAt", "expiresAt"])) return false;
  return typeof value.campaignId === "string" && idPattern.test(value.campaignId) &&
    typeof value.campaignTitle === "string" && value.campaignTitle.length > 0 && value.campaignTitle.length <= 255 &&
    ["SELECTED", "USED", "EXHAUSTED", "EXPIRED", "CLOSED", "NO_LONGER_ELIGIBLE", "REOPENED"].includes(String(value.status)) &&
    count(value.quantityGranted) && count(value.committedQuantity) && count(value.remainingQuantity) &&
    value.committedQuantity + value.remainingQuantity <= value.quantityGranted &&
    (value.lastSelectedAt === null || iso(value.lastSelectedAt)) && iso(value.expiresAt);
}

export function isPromotionReadResponse(value: unknown): value is PromotionReadResponse {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "revision", "offers", "offersPagination", "selection", "history"]) ||
    value.schemaVersion !== 1 || typeof value.revision !== "string" || !revisionPattern.test(value.revision) ||
    !Array.isArray(value.offers) || value.offers.length > PROMOTION_PAGE_SIZE ||
    !value.offers.every(validOffer) || !validPagination(value.offersPagination) ||
    !(value.selection === null || validSelection(value.selection)) ||
    !record(value.history) || !exactKeys(value.history, ["entries", "page", "pageSize", "totalEntries", "totalPages"]) ||
    !validPagination(value.history) || !Array.isArray(value.history.entries) ||
    value.history.entries.length > PROMOTION_PAGE_SIZE || !value.history.entries.every(validHistoryEntry)) return false;
  return new Set(value.offers.map((entry) => entry.id)).size === value.offers.length &&
    new Set(value.history.entries.map((entry) => entry.campaignId)).size === value.history.entries.length;
}

export function isPromotionSelectionResponse(value: unknown): value is PromotionSelectionResponse {
  return record(value) && exactKeys(value, ["schemaVersion", "revision", "selection"]) &&
    value.schemaVersion === 1 && typeof value.revision === "string" && revisionPattern.test(value.revision) &&
    validSelection(value.selection);
}
