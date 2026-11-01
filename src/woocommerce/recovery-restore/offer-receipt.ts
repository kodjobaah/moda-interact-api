import { InitialOutreachCheckoutOfferSetSchema } from "@modainteract/moda-interact-shared/commerce";
import {
  WooRestoreOutreachOfferV1Schema,
  type WooRestoreOutreachOfferV1,
} from "@modainteract/moda-interact-shared/woocommerce";

const RECEIPT_CONTRACT = "moda.whatsapp.automated-template-parameters.v1";
const MAX_RECEIPT_BYTES = 65_536;

export type WooOfferReceiptWarning = "INVALID_RECEIPT" | "UNVERIFIABLE_PROMISE" | "INVALID_OFFER_SET";

export type WooOfferReceiptResult = Readonly<{
  offer: WooRestoreOutreachOfferV1;
  warning?: WooOfferReceiptWarning;
}>;

const noConfirmedOffer: WooOfferReceiptResult = {
  offer: { kind: "NONE", reason: "NO_CONFIRMED_OFFER" },
};

function unverifiable(warning: WooOfferReceiptWarning): WooOfferReceiptResult {
  return { offer: { kind: "NONE", reason: "UNVERIFIABLE" }, warning };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function checkedOffer(value: unknown): WooRestoreOutreachOfferV1 | null {
  const parsed = WooRestoreOutreachOfferV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function checkoutOfferSet(value: unknown): WooRestoreOutreachOfferV1 | null {
  const parsedSet = InitialOutreachCheckoutOfferSetSchema.safeParse(value);
  if (!parsedSet.success || parsedSet.data.offers.length < 2) return null;

  const offerIds = new Set<string>();
  const discountIds = new Set<string>();
  const codes = new Set<string>();
  const offers: Array<
    | { method: "CODE"; code: string; providerDiscountId: string }
    | { method: "AUTOMATIC"; providerDiscountId: string }
  > = [];

  for (const item of parsedSet.data.offers) {
    if (!nonblank(item.offerId) || !nonblank(item.providerDiscountId) ||
      offerIds.has(item.offerId) || discountIds.has(item.providerDiscountId)) return null;
    offerIds.add(item.offerId);
    discountIds.add(item.providerDiscountId);
    if (item.method === "CODE") {
      if (!nonblank(item.code) || codes.has(item.code.toLowerCase())) return null;
      codes.add(item.code.toLowerCase());
      offers.push({ method: "CODE", code: item.code, providerDiscountId: item.providerDiscountId });
    } else {
      if (item.code !== null) return null;
      offers.push({ method: "AUTOMATIC", providerDiscountId: item.providerDiscountId });
    }
  }

  return checkedOffer({ kind: "CHECKOUT_OFFERS", offers });
}

export function parseWooOfferReceipt(content: string): WooOfferReceiptResult {
  if (Buffer.byteLength(content, "utf8") > MAX_RECEIPT_BYTES) return unverifiable("INVALID_RECEIPT");

  let decoded: unknown;
  try {
    decoded = JSON.parse(content) as unknown;
  } catch {
    return unverifiable("INVALID_RECEIPT");
  }

  const receipt = record(decoded);
  if (!receipt || receipt.contract !== RECEIPT_CONTRACT) return unverifiable("INVALID_RECEIPT");
  const promise = record(receipt.recoveryPromise);
  if (!promise || typeof promise.kind !== "string") return unverifiable("UNVERIFIABLE_PROMISE");

  if (promise.kind === "NO_OFFER") {
    return hasExactKeys(promise, ["kind"]) ? noConfirmedOffer : unverifiable("UNVERIFIABLE_PROMISE");
  }

  if (promise.kind === "ALTERNATIVE_PRODUCT_PROMOTION") {
    const sharedFields = [
      "kind", "promotionTarget", "offerId", "providerDiscountId", "method",
      "productId", "variantId", "productTitle",
    ];
    const methodFields = promise.method === "CODE" ? [...sharedFields, "code"] : sharedFields;
    if (promise.promotionTarget !== "ALTERNATIVE_PRODUCT" ||
        (promise.method !== "CODE" && promise.method !== "AUTOMATIC") ||
        !hasExactKeys(promise, methodFields) ||
        !nonblank(promise.offerId) || !nonblank(promise.providerDiscountId) ||
        !nonblank(promise.productId) || !nonblank(promise.productTitle) ||
        (promise.variantId !== null && !nonblank(promise.variantId)) ||
        (promise.method === "CODE" && (!nonblank(promise.code) || promise.code.length > 100))) {
      return unverifiable("UNVERIFIABLE_PROMISE");
    }
    return { offer: { kind: "ALTERNATIVE_PRODUCT" } };
  }

  if (!["CODE_OFFER", "AUTOMATIC_OFFER", "CHECKOUT_DISCOUNT"].includes(promise.kind)) {
    return unverifiable("UNVERIFIABLE_PROMISE");
  }
  if (promise.promotionTarget !== "CHECKOUT") return unverifiable("UNVERIFIABLE_PROMISE");

  if (promise.kind === "CODE_OFFER") {
    if (!hasExactKeys(promise, ["kind", "promotionTarget", "providerDiscountId", "code"])) {
      return unverifiable("UNVERIFIABLE_PROMISE");
    }
    if (!nonblank(promise.code) || !nonblank(promise.providerDiscountId)) {
      return unverifiable("UNVERIFIABLE_PROMISE");
    }
    const offer = checkedOffer({
      kind: "CHECKOUT_CODE",
      code: promise.code,
      providerDiscountId: promise.providerDiscountId,
    });
    return offer ? { offer } : unverifiable("UNVERIFIABLE_PROMISE");
  }

  if (promise.kind === "AUTOMATIC_OFFER") {
    if (!hasExactKeys(promise, ["kind", "promotionTarget", "providerDiscountId"])) {
      return unverifiable("UNVERIFIABLE_PROMISE");
    }
    if (!nonblank(promise.providerDiscountId)) return unverifiable("UNVERIFIABLE_PROMISE");
    const offer = checkedOffer({ kind: "CHECKOUT_AUTOMATIC", providerDiscountId: promise.providerDiscountId });
    return offer ? { offer } : unverifiable("UNVERIFIABLE_PROMISE");
  }

  if (!hasExactKeys(promise, ["kind", "promotionTarget", "offerSet"])) {
    return unverifiable("INVALID_OFFER_SET");
  }
  const offer = checkoutOfferSet(promise.offerSet);
  return offer ? { offer } : unverifiable("INVALID_OFFER_SET");
}