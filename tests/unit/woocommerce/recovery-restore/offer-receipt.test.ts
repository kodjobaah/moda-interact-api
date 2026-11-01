import assert from "node:assert/strict";
import test from "node:test";
import { parseWooOfferReceipt } from "../../../../src/woocommerce/recovery-restore/offer-receipt.js";

const contract = "moda.whatsapp.automated-template-parameters.v1";

function receipt(recoveryPromise: unknown): string {
  return JSON.stringify({ contract, templateName: "approved-template", recoveryPromise });
}

function offerSet(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "moda.outreach.checkout-offers.v1",
    offers: [
      { offerId: "offer-one", providerDiscountId: "discount-one", method: "CODE", code: "SAVE15", ...overrides },
      { offerId: "offer-two", providerDiscountId: "discount-two", method: "AUTOMATIC", code: null },
    ],
  };
}

test("maps only explicit confirmed receipt promises to the Shared v1 offer union", () => {
  assert.deepEqual(parseWooOfferReceipt(receipt({ kind: "NO_OFFER" })).offer,
    { kind: "NONE", reason: "NO_CONFIRMED_OFFER" });
  assert.deepEqual(parseWooOfferReceipt(receipt({
    kind: "CODE_OFFER", promotionTarget: "CHECKOUT", providerDiscountId: "discount-1", code: "SAVE15",
  })).offer, { kind: "CHECKOUT_CODE", providerDiscountId: "discount-1", code: "SAVE15" });
  assert.deepEqual(parseWooOfferReceipt(receipt({
    kind: "AUTOMATIC_OFFER", promotionTarget: "CHECKOUT", providerDiscountId: "discount-2",
  })).offer, { kind: "CHECKOUT_AUTOMATIC", providerDiscountId: "discount-2" });
});

test("maps exact production alternative-product receipts without exposing either offer code", () => {
  const codeReceipt = parseWooOfferReceipt(receipt({
    kind: "ALTERNATIVE_PRODUCT_PROMOTION",
    promotionTarget: "ALTERNATIVE_PRODUCT",
    offerId: "offer-code",
    providerDiscountId: "discount-code",
    method: "CODE",
    code: "PRODUCT15",
    productId: "product-101",
    variantId: "variant-202",
    productTitle: "Recommended product",
  }));
  const automaticReceipt = parseWooOfferReceipt(receipt({
    kind: "ALTERNATIVE_PRODUCT_PROMOTION",
    promotionTarget: "ALTERNATIVE_PRODUCT",
    offerId: "offer-automatic",
    providerDiscountId: "discount-automatic",
    method: "AUTOMATIC",
    productId: "product-303",
    variantId: null,
    productTitle: "Another recommended product",
  }));

  assert.deepEqual(codeReceipt.offer, { kind: "ALTERNATIVE_PRODUCT" });
  assert.deepEqual(automaticReceipt.offer, { kind: "ALTERNATIVE_PRODUCT" });
  assert.equal("code" in codeReceipt.offer, false);
  assert.equal("code" in automaticReceipt.offer, false);
  assert.equal(codeReceipt.warning, undefined);
  assert.equal(automaticReceipt.warning, undefined);
});

test("rejects malformed or contradictory alternative-product receipts", () => {
  const validCode = {
    kind: "ALTERNATIVE_PRODUCT_PROMOTION",
    promotionTarget: "ALTERNATIVE_PRODUCT",
    offerId: "offer-code",
    providerDiscountId: "discount-code",
    method: "CODE",
    code: "PRODUCT15",
    productId: "product-101",
    variantId: "variant-202",
    productTitle: "Recommended product",
  };
  const invalidPromises = [
    { ...validCode, code: "" },
    { ...validCode, method: "AUTOMATIC" },
    { ...validCode, productTitle: "  " },
    { ...validCode, variantId: 202 },
    { ...validCode, promotionTarget: "CHECKOUT" },
    { ...validCode, unexpected: true },
    {
      kind: "ALTERNATIVE_PRODUCT_PROMOTION", promotionTarget: "ALTERNATIVE_PRODUCT",
      offerId: "offer-auto", providerDiscountId: "discount-auto", method: "AUTOMATIC",
      code: null, productId: "product-101", variantId: null, productTitle: "Recommended product",
    },
    { kind: "CODE_OFFER", promotionTarget: "ALTERNATIVE_PRODUCT", providerDiscountId: "discount-1", code: "OTHER" },
  ];

  for (const promise of invalidPromises) {
    assert.deepEqual(parseWooOfferReceipt(receipt(promise)).offer, { kind: "NONE", reason: "UNVERIFIABLE" });
  }

  const contradictoryGroup = parseWooOfferReceipt(receipt({
    kind: "CHECKOUT_DISCOUNT", promotionTarget: "ALTERNATIVE_PRODUCT", offerSet: { invalid: true },
  }));
  assert.deepEqual(contradictoryGroup.offer, { kind: "NONE", reason: "UNVERIFIABLE" });
  assert.equal(contradictoryGroup.warning, "UNVERIFIABLE_PROMISE");
});

test("preserves every ordered checkout offer and rejects duplicate or malformed groups as a whole", () => {
  const parsed = parseWooOfferReceipt(receipt({
    kind: "CHECKOUT_DISCOUNT", promotionTarget: "CHECKOUT", offerSet: offerSet(),
  }));
  assert.deepEqual(parsed.offer, {
    kind: "CHECKOUT_OFFERS",
    offers: [
      { method: "CODE", code: "SAVE15", providerDiscountId: "discount-one" },
      { method: "AUTOMATIC", providerDiscountId: "discount-two" },
    ],
  });
  assert.equal(parsed.warning, undefined);

  const duplicate = offerSet();
  (duplicate.offers[1] as Record<string, unknown>).providerDiscountId = "discount-one";
  for (const invalidOfferSet of [
    duplicate,
    { ...offerSet(), offers: [offerSet().offers[0]] },
    { ...offerSet(), offers: [...offerSet().offers, { ...offerSet().offers[0], offerId: "offer-three" }] },
    { ...offerSet(), offers: [{ ...offerSet().offers[0], providerDiscountId: null }, offerSet().offers[1]] },
    { ...offerSet(), offers: [{ ...offerSet().offers[0], code: "  " }, offerSet().offers[1]] },
    { ...offerSet(), offers: [{ ...offerSet().offers[0], code: "SAVE15\n" }, offerSet().offers[1]] },
  ]) {
    const invalid = parseWooOfferReceipt(receipt({
      kind: "CHECKOUT_DISCOUNT", promotionTarget: "CHECKOUT", offerSet: invalidOfferSet,
    }));
    assert.deepEqual(invalid.offer, { kind: "NONE", reason: "UNVERIFIABLE" });
    assert.equal(invalid.warning, "INVALID_OFFER_SET");
  }
});

test("legacy, untagged, mismatched, corrupt, and unsupported evidence is unverifiable without text inference", () => {
  const cases = [
    "not-json",
    JSON.stringify({ contract: "other.contract", recoveryPromise: { kind: "CODE_OFFER", code: "SAVE15" } }),
    receipt({ kind: "CODE_OFFER", providerDiscountId: "discount-1", code: "SAVE15" }),
    receipt({ kind: "CODE_OFFER", promotionTarget: "CHECKOUT", providerDiscountId: "discount-1" }),
    receipt({ kind: "AUTOMATIC_OFFER", promotionTarget: "CHECKOUT", providerDiscountId: "discount-2", code: "SAVE15" }),
    "x".repeat(65_537),
  ];
  for (const content of cases) {
    assert.deepEqual(parseWooOfferReceipt(content).offer, { kind: "NONE", reason: "UNVERIFIABLE" });
  }
});