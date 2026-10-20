import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { parseWooCheckoutEvent, WooActivityRequestError } from "../../../../src/woocommerce/activity/contract.js";
import { event } from "../../../fixtures/woocommerce/activity/checkout-event.js";

test("contract fixtures agree with the strict API v1 parser", () => {
  const checkout = JSON.parse(readFileSync("tests/fixtures/woocommerce/activity/checkout.json", "utf8")) as unknown;
  assert.deepEqual(parseWooCheckoutEvent(checkout), event);
  const reserved = JSON.parse(readFileSync("tests/fixtures/woocommerce/activity/reserved-order.json", "utf8")) as unknown;
  assert.throws(() => parseWooCheckoutEvent(reserved), (e: unknown) =>
    e instanceof WooActivityRequestError && e.status === 422);
});

test("OpenAPI documents bounded capture-only checkout, reserved order and Redis failure", () => {
  const openapi = parse(readFileSync("openapi/woocommerce-activity-v1.yaml", "utf8")) as {
    paths: Record<string, { post: { responses: Record<string, unknown> } }>;
    components: { schemas: Record<string, Record<string, unknown>> };
  };
  const operation = openapi.paths["/v1/woocommerce/activity"]?.post;
  assert.ok(operation);
  for (const status of ["202", "400", "401", "409", "413", "422", "503"]) assert.ok(operation.responses[status]);
  const checkout = openapi.components.schemas.CheckoutEvent;
  const reserved = openapi.components.schemas.ReservedOrderEvent;
  const snapshot = openapi.components.schemas.CheckoutSnapshot;
  assert.ok(checkout);
  assert.ok(reserved);
  assert.ok(snapshot);
  assert.equal(checkout.additionalProperties, false);
  assert.equal(reserved.additionalProperties, false);
  assert.equal(snapshot.additionalProperties, false);
  assert.ok(JSON.stringify(openapi).includes("job is retained"));
  assert.equal(JSON.stringify(openapi).includes("permanent replay ledger"), true);
});
