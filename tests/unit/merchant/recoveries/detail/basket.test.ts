import assert from "node:assert/strict";
import test from "node:test";
import { recoveryBasket } from "../../../../../src/merchant/recoveries/detail/basket.js";

const total = { amount: "1234567890123456.123456", currency: "GBP" };
test("saved v1 basket keeps exact strings and never invents line total/image", () => {
  const basket = recoveryBasket([
    { title: "  Jumper  ", variantTitle: "Large", quantity: 3, price: "12.3000", productId: "secret-id", sku: "SKU" },
    { title: "Hat", variantTitle: null, quantity: 1, price: "0.01" },
  ], total, "GBP");
  assert.equal(basket.items.length, 2);
  assert.deepEqual(basket.items[0], { title: "Jumper", variantTitle: "Large", quantity: 3,
    unitPrice: { amount: "12.3000", currency: "GBP" }, lineTotal: null, imageUrl: null });
  assert.deepEqual(basket.recoveryTotal, total);
  assert.equal(basket.unavailableReason, null);
  assert.doesNotMatch(JSON.stringify(basket), /secret-id|SKU/);
});
test("null, empty, invalid, partial and oversized snapshots degrade safely", () => {
  assert.deepEqual(recoveryBasket(null, total, "GBP"),
    { items: [], recoveryTotal: total, unavailableReason: "missing_snapshot" });
  assert.equal(recoveryBasket([], total, "GBP").unavailableReason, null);
  assert.equal(recoveryBasket({ raw: "token" }, total, "GBP").unavailableReason, "invalid_snapshot");
  const partial = recoveryBasket([{ title: "One", quantity: 2, price: "2.5" },
    { title: "Unsafe", quantity: -6, price: "not-money", imageUrl: "javascript:alert(1)" },
    null], total, "GBP");
  assert.equal(partial.items.length, 2);
  assert.equal(partial.unavailableReason, "partial_snapshot");
  assert.equal(partial.items[1]?.unitPrice, null);
  assert.equal(partial.items[1]?.imageUrl, null);
  assert.equal(recoveryBasket(Array(251).fill({ title: "x" }), total, "GBP").unavailableReason, "oversized_snapshot");
});
