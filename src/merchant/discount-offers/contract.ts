/** ARCH-036 API-owned, versioned, Woo-only merchant coupon configuration contract. */
export const DISCOUNT_CATALOGUE_PATH = "/v1/merchant/discount-catalogue";
export const DISCOUNT_OFFERS_PATH = "/v1/merchant/discount-offers";
export const MAX_DISCOUNT_SAVE_BYTES = 8192;
export const MAX_SELECTED_DISCOUNTS = 50;
export type OfferMode = "NONE" | "FIXED" | "AI_BEST_APPLICABLE";

export class DiscountOffersError extends Error {
  constructor(readonly status: 400 | 409 | 413 | 422 | 503, readonly code:
    "invalid_request" | "request_too_large" | "shop_unavailable" | "catalogue_not_current" |
    "offers_conflict" | "selected_coupon_not_found" | "selection_required" | "selection_limit_exceeded") {
    super(code);
  }
}

export interface SaveDiscountOffers {
  recoveryOfferMode: OfferMode;
  selectedDiscountIds: string[];
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function parseSaveDiscountOffers(value: unknown): SaveDiscountOffers {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DiscountOffersError(400, "invalid_request");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== ["recoveryOfferMode", "selectedDiscountIds"].sort().join(",") ||
    !["NONE", "FIXED", "AI_BEST_APPLICABLE"].includes(String(object.recoveryOfferMode)) ||
    !Array.isArray(object.selectedDiscountIds)) throw new DiscountOffersError(400, "invalid_request");
  const ids = object.selectedDiscountIds as unknown[];
  if (ids.length > MAX_SELECTED_DISCOUNTS) throw new DiscountOffersError(422, "selection_limit_exceeded");
  if (ids.some(id => typeof id !== "string" || !ID.test(id)) || new Set(ids).size !== ids.length) {
    throw new DiscountOffersError(400, "invalid_request");
  }
  if (object.recoveryOfferMode === "FIXED" && ids.length === 0) {
    throw new DiscountOffersError(422, "selection_required");
  }
  return { recoveryOfferMode: object.recoveryOfferMode as OfferMode,
    selectedDiscountIds: ids as string[] };
}

export function readCatalogueQuery(search: URLSearchParams): { cursor?: string; limit: number; search?: string } {
  if ([...search.keys()].some(key => !["cursor", "limit", "search"].includes(key)) ||
    ["cursor", "limit", "search"].some(key => search.getAll(key).length > 1)) throw new DiscountOffersError(400, "invalid_request");
  const cursor = search.get("cursor");
  const limitValue = search.get("limit");
  const term = search.get("search");
  if (cursor !== null && !ID.test(cursor) || limitValue !== null && !/^(?:[1-9]|[1-4]\d|50)$/.test(limitValue) ||
    term !== null && (term.length > 80 || Array.from(term).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }))) {
    throw new DiscountOffersError(400, "invalid_request");
  }
  return { ...(cursor ? {cursor} : {}), limit: limitValue ? Number(limitValue) : 25,
    ...(term?.trim() ? {search: term.trim()} : {}) };
}

/** Informational snapshot token for reads. Merchant Save deliberately does not compare it. */
export function offerRevision(settingsUpdatedAt: Date | null, catalogue: {
  status: string; syncGeneration: number; updatedAt: Date;
} | null): string {
  return Buffer.from(JSON.stringify([
    settingsUpdatedAt?.toISOString() ?? null, catalogue?.status ?? null,
    catalogue?.syncGeneration ?? null, catalogue?.updatedAt.toISOString() ?? null,
  ]), "utf8").toString("base64url");
}
