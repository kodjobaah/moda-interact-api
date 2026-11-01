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
  assert.deepEqual(parseWooOfferReceipt(receipt({
    kind: "CODE_OFFER", promotionTarget: "ALTERNATIVE_PRODUCT", providerDiscountId: "discount-3", code: "OTHER",
  })).offer, { kind: "ALTERNATIVE_PRODUCT" });
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
  assert.deepEqual(parseWooOfferReceipt(receipt({
    kind: "CHECKOUT_DISCOUNT", promotionTarget: "ALTERNATIVE_PRODUCT", offerSet: { invalid: true },
  })).offer, { kind: "ALTERNATIVE_PRODUCT" });
});