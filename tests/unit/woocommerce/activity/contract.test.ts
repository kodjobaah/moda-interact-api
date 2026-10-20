import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWooCheckoutEvent, WooActivityRequestError, MAX_WOO_ACTIVITY_BYTES,
} from "../../../../src/woocommerce/activity/contract.js";
import { event } from "../../../fixtures/woocommerce/activity/checkout-event.js";

test("accepts canonical checkout fields and keeps optional contact absent", () => {
  assert.deepEqual(parseWooCheckoutEvent(event), event);
  assert.deepEqual(parseWooCheckoutEvent({ ...event, checkout: {
    currency: "GBP", total: "0", items: [], contact: { phone: "+447000000000", firstName: "A" },
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
