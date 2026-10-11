import assert from "node:assert/strict";
import test from "node:test";
import { isWooPurchaseHistoryResponse } from "./schema.js";

const empty = {
  schemaVersion: 1,
  filter: "ACTIVE",
  page: 1,
  pageSize: 5,
  total: 0,
  totalPages: 1,
  purchases: [],
  refundRequest: { method: "WOOCOMMERCE_ORDERS", url: "https://woocommerce.com/my-account/orders/" },
};

test("strict history response accepts empty page, rejects provider IDs and unsafe redirect", () => {
  assert.equal(isWooPurchaseHistoryResponse(empty), true);
  assert.equal(isWooPurchaseHistoryResponse({ ...empty, providerReference: "leak" }), false);
  assert.equal(isWooPurchaseHistoryResponse({ ...empty, refundRequest: { ...empty.refundRequest, url: "https://example.com/" } }), false);
  assert.equal(isWooPurchaseHistoryResponse({ ...empty, refundRequest: { ...empty.refundRequest, method: "LOCAL_REFUND" } }), false);
  assert.equal(isWooPurchaseHistoryResponse({ ...empty, page: 2 }), false);
});

test("strict row projection rejects extra provider fields and fabricated merchant eligibility", () => {
  const row = {
    id: "purchase-1", status: "ACTIVE", createdAt: "2026-10-11T00:00:00.000Z", activatedAt: null,
    bundleLabel: "Bronze", planName: "Free", creditsGranted: 1, currentAmount: 1, reservedAmount: 0,
    availableAmount: 1, heldForRefundAmount: 0, refundEligible: true,
    refundUnavailableReason: null, refundAttempted: false,
    latestRefund: null, completedRefund: null, originalProviderPurchase: { amount: "120.00", currency: "USD" },
  };
  assert.equal(isWooPurchaseHistoryResponse({ ...empty, total: 1, purchases: [row] }), true);
  assert.equal(isWooPurchaseHistoryResponse({ ...empty, total: 1, purchases: [{ ...row, providerContractId: "secret" }] }), false);
  assert.equal(isWooPurchaseHistoryResponse({ ...empty, total: 1, purchases: [{ ...row, refundEligible: true, refundUnavailableReason: "REFUND_ALREADY_ATTEMPTED" }] }), false);
  assert.equal(isWooPurchaseHistoryResponse({ ...empty, total: 1, purchases: [{ ...row, originalProviderPurchase: { amount: "12", currency: "USD", rawPrice: "secret" } }] }), false);
});
