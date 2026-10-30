import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { parseWooCheckoutEvent, parseWooActivityEvent, WooActivityRequestError } from "../../../../src/woocommerce/activity/contract.js";
import { event } from "../../../fixtures/woocommerce/activity/checkout-event.js";
import { orderPlaced, orderPaid, orderCancelled } from "../../../fixtures/woocommerce/activity/order-event.js";

test("contract fixtures agree with the strict API v1 parser", () => {
  const checkout = JSON.parse(readFileSync("tests/fixtures/woocommerce/activity/checkout.json", "utf8")) as unknown;
  assert.deepEqual(parseWooCheckoutEvent(checkout), event);
  const order = JSON.parse(readFileSync("tests/fixtures/woocommerce/activity/order-placed.json", "utf8")) as unknown;
  assert.equal(parseWooActivityEvent(order).eventType, "ORDER_PLACED");
  for (const item of [orderPlaced, orderPaid, orderCancelled]) {
    assert.deepEqual(parseWooActivityEvent(item), item);
  }
  assert.throws(() => parseWooCheckoutEvent(order), (e: unknown) =>
    e instanceof WooActivityRequestError && e.status === 422);
});

test("OpenAPI documents all four capture-only event types and Redis failure", () => {
  const openapi = parse(readFileSync("openapi/woocommerce-activity-v1.yaml", "utf8")) as {
    paths: Record<string, { post: { responses: Record<string, unknown> } }>;
    components: { schemas: Record<string, Record<string, unknown>> };
  };
  const operation = openapi.paths["/v1/woocommerce/activity"]?.post;
  assert.ok(operation);
  for (const status of ["202", "400", "401", "409", "413", "503"]) assert.ok(operation.responses[status]);
  const checkout = openapi.components.schemas.CheckoutEvent;
  const order = openapi.components.schemas.OrderEvent;
  const snapshot = openapi.components.schemas.CheckoutSnapshot;
  assert.ok(checkout);
  assert.ok(order);
  assert.ok(snapshot);
  assert.equal(checkout.additionalProperties, false);
  assert.equal(order.additionalProperties, false);
  const orderObject = (order.properties as Record<string, unknown>).order as { required: string[]; additionalProperties: boolean };
  assert.deepEqual(orderObject.required, ["orderId", "checkoutKey", "status"]);
  assert.equal(orderObject.additionalProperties, false);
  assert.equal(snapshot.additionalProperties, false);
  assert.ok("restoration" in (snapshot.properties as Record<string, unknown>));
  assert.equal("WooCartRestoreSnapshotV1" in openapi.components.schemas, true);
  const contact = openapi.components.schemas.CheckoutContact;
  assert.ok(contact);
  assert.ok("canonicalPhone" in (contact.properties as Record<string, unknown>));
  assert.ok("verifiedCountryCode" in (contact.properties as Record<string, unknown>));
  assert.ok(JSON.stringify(openapi).includes("job is retained"));
  assert.equal(JSON.stringify(openapi).includes("permanent replay ledger"), true);
});
