import { WOO_ACTIVITY_VERSION, type WooOrderEvent } from "../../../../src/woocommerce/activity/contract.js";

export const orderPlaced: WooOrderEvent = {
  schemaVersion: WOO_ACTIVITY_VERSION,
  eventId: "woo-order-42-placed",
  eventType: "ORDER_PLACED",
  checkoutKey: "cart-001",
  occurredAt: "2026-10-20T12:01:00.000Z",
  order: { orderId: "42", checkoutKey: "cart-001", status: "processing" },
};
export const orderPaid: WooOrderEvent = {
  ...orderPlaced, eventId: "woo-order-42-paid", eventType: "ORDER_PAID",
  occurredAt: "2026-10-20T12:02:00.000Z", order: { ...orderPlaced.order, status: "completed" },
};
export const orderCancelled: WooOrderEvent = {
  ...orderPlaced, eventId: "woo-order-42-cancelled", eventType: "ORDER_CANCELLED",
  occurredAt: "2026-10-20T12:03:00.000Z", order: { ...orderPlaced.order, status: "cancelled" },
};
