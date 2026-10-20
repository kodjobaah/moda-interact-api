/** API-owned capture-only v1 contract; intentionally separate from Shopify recovery events. */
export const WOO_ACTIVITY_PATH = "/v1/woocommerce/activity";
export const WOO_CHECKOUT_QUEUE = "woo-checkout-capture-v1";
export const WOO_ORDER_QUEUE = "woo-order-capture-v1";
export const WOO_ACTIVITY_VERSION = "woo.activity.v1";
export const MAX_WOO_ACTIVITY_BYTES = 65_536;

export interface WooCheckoutItem {
  quantity: number;
  productId?: string;
  variationId?: string;
  sku?: string;
  title?: string;
  unitPrice?: string;
  total?: string;
}
export interface WooCheckoutContact {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
}
export interface WooCheckoutSnapshot {
  currency: string;
  total: string;
  items?: WooCheckoutItem[];
  contact?: WooCheckoutContact;
}
export interface WooCheckoutEvent {
  schemaVersion: typeof WOO_ACTIVITY_VERSION;
  eventId: string;
  eventType: "CHECKOUT_UPDATED";
  checkoutKey: string;
  occurredAt: string;
  checkout: WooCheckoutSnapshot;
}
export type WooOrderEventType = "ORDER_PLACED" | "ORDER_PAID" | "ORDER_CANCELLED";
export interface WooOrderSnapshot {
  orderId: string;
  /** Must be the exact stable checkoutKey from the top-level envelope. */
  checkoutKey: string;
  /** Observed Woo order status, not proof of payment or a recovery transition. */
  status: string;
}
export interface WooOrderEvent {
  schemaVersion: typeof WOO_ACTIVITY_VERSION;
  eventId: string;
  eventType: WooOrderEventType;
  checkoutKey: string;
  occurredAt: string;
  order: WooOrderSnapshot;
}
export type WooActivityEvent = WooCheckoutEvent | WooOrderEvent;

export interface WooOrderJob extends WooOrderEvent {
  /** Authenticated installation's Shop, never supplied by the client. */
  shopId: string;
  contentDigest: string;
}
export interface WooCheckoutJob extends WooCheckoutEvent {
  /** Authenticated installation's Shop, never supplied by the client. */
  shopId: string;
  /** SHA-256 of the canonical, validated event, for retained-job replay checking. */
  contentDigest: string;
}

export class WooActivityRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const invalid = () => new WooActivityRequestError(400, "invalid_request");
const DECIMAL = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
const TEXT_SAFE = /^[^\p{Cc}]*$/u;

function object(value: unknown, required: readonly string[], allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(record, key))) throw invalid();
  return record;
}
function text(value: unknown, max: number, min = 1): string {
  if (typeof value !== "string" || value.length < min || value.length > max || !TEXT_SAFE.test(value)) throw invalid();
  return value;
}
function optionalString(record: Record<string, unknown>, key: string, limit: number): string | undefined {
  return Object.hasOwn(record, key) ? text(record[key], limit) : undefined;
}
function money(value: unknown): string {
  const candidate = text(value, 14);
  if (!DECIMAL.test(candidate)) throw invalid();
  return candidate;
}
function parseItem(value: unknown): WooCheckoutItem {
  const input = object(value, ["quantity"], ["quantity", "productId", "variationId", "sku", "title", "unitPrice", "total"]);
  const quantity = input.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) throw invalid();
  return {
    quantity,
    ...(Object.hasOwn(input, "productId") ? { productId: text(input.productId, 128) } : {}),
    ...(Object.hasOwn(input, "variationId") ? { variationId: text(input.variationId, 128) } : {}),
    ...(Object.hasOwn(input, "sku") ? { sku: text(input.sku, 128) } : {}),
    ...(Object.hasOwn(input, "title") ? { title: text(input.title, 200) } : {}),
    ...(Object.hasOwn(input, "unitPrice") ? { unitPrice: money(input.unitPrice) } : {}),
    ...(Object.hasOwn(input, "total") ? { total: money(input.total) } : {}),
  };
}
function parseContact(value: unknown): WooCheckoutContact {
  const input = object(value, [], ["email", "phone", "firstName", "lastName"]);
  const email = optionalString(input, "email", 254);
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.includes("<"))) throw invalid();
  const phone = optionalString(input, "phone", 32);
  if (phone && !/^\+?[0-9 ()-]{5,32}$/.test(phone)) throw invalid();
  return {
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(Object.hasOwn(input, "firstName") ? { firstName: text(input.firstName, 100) } : {}),
    ...(Object.hasOwn(input, "lastName") ? { lastName: text(input.lastName, 100) } : {}),
  };
}

/** Validate the common event identity once, then project a canonical field order. */
function parseIdentity(value: unknown) {
  const input = object(value,
    ["schemaVersion", "eventId", "eventType", "checkoutKey", "occurredAt"],
    ["schemaVersion", "eventId", "eventType", "checkoutKey", "occurredAt", "checkout", "order"]);
  if (input.schemaVersion !== WOO_ACTIVITY_VERSION) throw invalid();
  const eventId = text(input.eventId, 128);
  const checkoutKey = text(input.checkoutKey, 128);
  if (!OPAQUE_ID.test(eventId) || !OPAQUE_ID.test(checkoutKey)) throw invalid();
  const occurredAt = text(input.occurredAt, 30);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(occurredAt) ||
      !Number.isFinite(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt) throw invalid();
  return { input, eventId, checkoutKey, occurredAt };
}

/** Strict checkout parser retained for API-008 callers. */
export function parseWooCheckoutEvent(value: unknown): WooCheckoutEvent {
  const { input, eventId, checkoutKey, occurredAt } = parseIdentity(value);
  if (input.eventType !== "CHECKOUT_UPDATED") {
    if (["ORDER_PLACED", "ORDER_PAID", "ORDER_CANCELLED"].includes(String(input.eventType))) {
      // API-019 enables order events on this route; API-008 never enqueues them.
      throw new WooActivityRequestError(422, "event_type_not_enabled");
    }
    throw invalid();
  }
  if (!Object.hasOwn(input, "checkout") || Object.hasOwn(input, "order")) throw invalid();
  const checkout = object(input.checkout, ["currency", "total"], ["currency", "total", "items", "contact"]);
  const currency = text(checkout.currency, 3, 3);
  if (!/^[A-Z]{3}$/.test(currency)) throw invalid();
  const items = checkout.items;
  if (items !== undefined && (!Array.isArray(items) || items.length > 50)) throw invalid();
  return {
    schemaVersion: WOO_ACTIVITY_VERSION,
    eventId,
    eventType: "CHECKOUT_UPDATED",
    checkoutKey,
    occurredAt,
    checkout: {
      currency,
      total: money(checkout.total),
      ...(items !== undefined ? { items: (items as unknown[]).map(parseItem) } : {}),
      ...(Object.hasOwn(checkout, "contact") ? { contact: parseContact(checkout.contact) } : {}),
    },
  };
}

/** A Woo order event is capture-only and may arrive before its checkout snapshot. */
export function parseWooOrderEvent(value: unknown): WooOrderEvent {
  const { input, eventId, checkoutKey, occurredAt } = parseIdentity(value);
  if (input.eventType !== "ORDER_PLACED" && input.eventType !== "ORDER_PAID" &&
      input.eventType !== "ORDER_CANCELLED") throw invalid();
  if (!Object.hasOwn(input, "order") || Object.hasOwn(input, "checkout")) throw invalid();
  const order = object(input.order, ["orderId", "checkoutKey", "status"], ["orderId", "checkoutKey", "status"]);
  const orderId = text(order.orderId, 128);
  const orderCheckoutKey = text(order.checkoutKey, 128);
  const status = text(order.status, 64);
  if (!OPAQUE_ID.test(orderId) || !OPAQUE_ID.test(orderCheckoutKey) || orderCheckoutKey !== checkoutKey ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(status)) throw invalid();
  return {
    schemaVersion: WOO_ACTIVITY_VERSION, eventId, eventType: input.eventType,
    checkoutKey, occurredAt, order: { orderId, checkoutKey: orderCheckoutKey, status },
  };
}

/** One strict envelope for the existing authenticated activity route. */
export function parseWooActivityEvent(value: unknown): WooActivityEvent {
  const kind = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).eventType : undefined;
  if (kind === "ORDER_PLACED" || kind === "ORDER_PAID" || kind === "ORDER_CANCELLED") {
    return parseWooOrderEvent(value);
  }
  return parseWooCheckoutEvent(value);
}
