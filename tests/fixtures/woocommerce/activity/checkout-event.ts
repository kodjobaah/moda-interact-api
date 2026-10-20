import { WOO_ACTIVITY_VERSION, type WooCheckoutEvent } from "../../../../src/woocommerce/activity/contract.js";

export const event: WooCheckoutEvent = {
  schemaVersion: WOO_ACTIVITY_VERSION,
  eventId: "evt-001",
  eventType: "CHECKOUT_UPDATED",
  checkoutKey: "cart-001",
  occurredAt: "2026-10-20T12:00:00.000Z",
  checkout: { currency: "GBP", total: "29.99", items: [{ productId: "42", quantity: 2, total: "29.99" }] },
};
