import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWooCheckoutEvent, parseWooActivityEvent, WooActivityRequestError, MAX_WOO_ACTIVITY_BYTES,
} from "../../../../src/woocommerce/activity/contract.js";
import { event } from "../../../fixtures/woocommerce/activity/checkout-event.js";
import { orderPlaced, orderPaid, orderCancelled } from "../../../fixtures/woocommerce/activity/order-event.js";

test("accepts canonical checkout fields and keeps optional contact absent", () => {
  assert.deepEqual(parseWooCheckoutEvent(event), event);
  assert.deepEqual(parseWooCheckoutEvent({ ...event, checkout: {
    currency: "GBP", total: "0", items: [], contact: {
      phone: "+447000000000", canonicalPhone: "447000000000", firstName: "A",
    },
  } }).checkout.contact, { phone: "+447000000000", firstName: "A" });
  assert.equal(MAX_WOO_ACTIVITY_BYTES, 65_536);
});

test("rejects spoofed identity, unknown nested fields, oversized arrays and malformed money", () => {
  const cases = [
    { ...event, shopId: "victim" },
    { ...event, checkout: { ...event.checkout, shopId: "victim" } },
    { ...event, checkout: { ...event.checkout, items: [{ quantity: 1, consent: true }] } },
    { ...event, checkout: { ...event.checkout, contact: { consent: true } } },
    { ...event, checkout: { ...event.checkout, contact: { email: "bad" } } },
    { ...event, checkout: { ...event.checkout, items: Array(51).fill({ quantity: 1 }) } },
    { ...event, checkout: { ...event.checkout, total: 29.99 } },
    { ...event, checkout: { ...event.checkout, total: "01.23" } },
    { ...event, checkout: { ...event.checkout, currency: "gbp" } },
    { ...event, eventId: "bad id" },
    { ...event, occurredAt: "2026-02-30T00:00:00.000Z" },
    { ...event, schemaVersion: "woo.activity.v2" },
    { ...event, schemaVersion: "woo.activity.v3" },
    { ...event, eventType: "UNKNOWN" },
  ];
  for (const value of cases) assert.throws(() => parseWooCheckoutEvent(value), (err: unknown) =>
    err instanceof WooActivityRequestError && err.status === 400);
});

test("order cases are reserved and never mistaken for checkout events", () => {
  for (const eventType of ["ORDER_PLACED", "ORDER_PAID", "ORDER_CANCELLED"]) {
    assert.throws(() => parseWooCheckoutEvent({
      ...event, eventType, order: { orderId: "1", status: "processing" }, checkout: undefined,
    }), (error: unknown) => error instanceof WooActivityRequestError && error.status === 422);
  }
});

test("all three authoritative Woo order types retain correlation and event identity", () => {
  for (const order of [orderPlaced, orderPaid, orderCancelled]) {
    assert.deepEqual(parseWooActivityEvent(order), order);
    assert.equal(parseWooActivityEvent(order).checkoutKey, "cart-001");
  }
  assert.deepEqual(parseWooActivityEvent(event), event);
});

test("rejects uncorrelated, foreign-shop, malformed and fabricated order evidence", () => {
  const invalidOrders: unknown[] = [
    { ...orderPlaced, shopId: "foreign-shop" },
    { ...orderPlaced, order: { ...orderPlaced.order, shopId: "foreign-shop" } },
    { ...orderPlaced, order: { ...orderPlaced.order, checkoutKey: "other-cart" } },
    { ...orderPlaced, order: { orderId: "42", status: "processing" } },
    { ...orderPlaced, checkoutKey: "" },
    { ...orderPlaced, checkoutKey: "foreign/cart" },
    { ...orderPlaced, order: { ...orderPlaced.order, checkoutKey: "" } },
    { ...orderPlaced, order: { ...orderPlaced.order, orderId: "" } },
    { ...orderPlaced, order: { ...orderPlaced.order, status: "" } },
    { ...orderPlaced, order: { ...orderPlaced.order, status: "processing\nsecret" } },
    { ...orderPlaced, order: { ...orderPlaced.order, status: "PENDING" } },
    { ...orderPlaced, order: { ...orderPlaced.order, email: "shopper@example.test" } },
    { ...orderPlaced, checkout: event.checkout },
    { ...orderPlaced, eventId: "bad id" },
    { ...orderPlaced, occurredAt: "2026-02-30T12:01:00.000Z" },
    { ...orderPlaced, eventType: "ORDER_REFUNDED" },
    { ...orderPlaced, eventType: "CHECKOUT_UPDATED" },
  ];
  for (const payload of invalidOrders) assert.throws(() => parseWooActivityEvent(payload), (error: unknown) =>
    error instanceof WooActivityRequestError && error.status === 400);
});

test("v1 verifies phone proof, strips HTTP-only evidence, and accepts phone-free contact", () => {
  const input = {
    ...event, checkout: { ...event.checkout, contact: {
      phone: "07400 123456", canonicalPhone: "447400123456", verifiedCountryCode: "GB",
      email: "customer@example.com", firstName: "A",
    } },
  };
  const projected = parseWooActivityEvent(input);
  assert.equal(projected.schemaVersion, "woo.activity.v1");
  if (projected.eventType !== "CHECKOUT_UPDATED") throw new Error("expected checkout");
  assert.deepEqual(projected.checkout.contact, {
    phone: "+447400123456", email: "customer@example.com", firstName: "A",
  });
  const noPhone = parseWooActivityEvent({ ...event, checkout: { ...event.checkout, contact: { email: "customer@example.com" } } });
  if (noPhone.eventType !== "CHECKOUT_UPDATED") throw new Error("expected checkout");
  assert.deepEqual(noPhone.checkout.contact, { email: "customer@example.com" });
  const international = parseWooActivityEvent({ ...event, checkout: { ...event.checkout, contact: {
    phone: "+447400123456", canonicalPhone: "447400123456",
  } } });
  if (international.eventType !== "CHECKOUT_UPDATED") throw new Error("expected checkout");
  assert.equal(international.checkout.contact?.phone, "+447400123456");
  for (const bad of [
    { ...input, checkout: { ...input.checkout, contact: { ...input.checkout.contact, canonicalPhone: "447400123459" } } },
    { ...input, checkout: { ...input.checkout, contact: { phone: "07400 123456" } } },
    { ...input, checkout: { ...input.checkout, contact: { ...input.checkout.contact, verifiedCountryCode: "FR" } } },
    { ...input, checkout: { ...input.checkout, contact: { phone: "020 7183 8750", canonicalPhone: "442071838750" } } },
    { ...event, checkout: { ...event.checkout, contact: { canonicalPhone: "447400123456" } } },
    { ...event, checkout: { ...event.checkout, contact: { verifiedCountryCode: "GB" } } },
    { ...input, checkout: { ...input.checkout, contact: { ...input.checkout.contact, consent: true } } },
    { ...input, shopId: "forged" },
  ]) assert.throws(() => parseWooActivityEvent(bad), WooActivityRequestError);
});

test("v1 carries Shared-validated restoration without changing its shape or coupon evidence", () => {
  const supported = {
    schemaVersion: "woo.cart-restore.v1", kind: "supported", appliedCouponCodes: ["Original-Code", "FREESHIP"],
    lines: [{ productId: "101", quantity: 2 }, {
      productId: "202", variationId: "207", quantity: 1,
      attributes: { attribute_pa_color: "navy", attribute_pa_size: "m" },
    }],
  } as const;
  const unsupported = {
    schemaVersion: "woo.cart-restore.v1", kind: "unsupported", reason: "CUSTOM_CART_ITEM_DATA",
    appliedCouponCodes: ["Original-Code"],
  } as const;
  const withSupported = parseWooActivityEvent({ ...event, checkout: { ...event.checkout, restoration: supported } });
  if (withSupported.eventType !== "CHECKOUT_UPDATED") throw new Error("expected checkout");
  assert.deepEqual(withSupported.checkout.restoration, supported);
  const withUnsupported = parseWooActivityEvent({ ...event, checkout: { ...event.checkout, restoration: unsupported } });
  if (withUnsupported.eventType !== "CHECKOUT_UPDATED") throw new Error("expected checkout");
  assert.deepEqual(withUnsupported.checkout.restoration, unsupported);
  const absent = parseWooActivityEvent(event);
  if (absent.eventType !== "CHECKOUT_UPDATED") throw new Error("expected checkout");
  assert.equal(Object.hasOwn(absent.checkout, "restoration"), false);
  for (const invalid of [
    { ...supported, lines: [{ productId: "101", quantity: 0 }] },
    { ...supported, appliedCouponCodes: [1] },
    { ...supported, extra: "unknown" },
    { ...supported, lines: [{ productId: "101", quantity: 1, attributes: { color: 1 } }] },
  ]) assert.throws(() => parseWooActivityEvent({ ...event, checkout: { ...event.checkout, restoration: invalid } }),
    (error: unknown) => error instanceof WooActivityRequestError && error.status === 400);
});
