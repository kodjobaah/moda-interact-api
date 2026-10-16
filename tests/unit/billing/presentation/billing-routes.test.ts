import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { BillingPresentationError } from "../../../../src/billing/presentation/billing-read.service.js";
import { BILLING_PRESENTATION_ROUTE_PATH, BILLING_PLANS_ROUTE_PATH } from "../../../../src/billing/presentation/routes.js";
import { authorizedHeaders, billingResponse, fixture, readRawGet, withRouter } from "./route-fixtures.js";

test("billing read delegates only after authentication and retains v1 headers, body and log fields", async () => {
  const { router, calls, events } = fixture();
  await withRouter(router, async (origin) => {
    const response = await fetch(`${origin}${BILLING_PRESENTATION_ROUTE_PATH}`, { headers: authorizedHeaders });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await response.json(), billingResponse);
  });
  assert.deepEqual(calls, ["authenticate", "billing:verified-shop:2026-10-16T12:00:00.000Z"]);
  assert.deepEqual(events, [{
    level: "info", name: "billing.presentation.read", data: {
      shopId: "verified-shop", experienceState: "ACTIVE", planKind: null, planId: null,
      returnedTopUpCount: 0, outcome: "success", durationMs: 0,
    },
  }]);
});
test("both billing GET endpoints reject unauthenticated callers before parsing queries", async () => {
  const { router, calls, events } = fixture();
  await withRouter(router, async (origin) => {
    for (const path of [BILLING_PRESENTATION_ROUTE_PATH + "?shopId=x", BILLING_PLANS_ROUTE_PATH + "?unknown=1"]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
  });
  assert.deepEqual(calls, ["authenticate", "authenticate"]);
  assert.deepEqual(events, []);
});
test("billing GET rejects any query and both GET endpoints reject non-empty request bodies", async () => {
  const { router, calls } = fixture();
  await withRouter(router, async (origin) => {
    const invalidQuery = await fetch(`${origin}${BILLING_PRESENTATION_ROUTE_PATH}?locale=en`, { headers: authorizedHeaders });
    assert.equal(invalidQuery.status, 400);
    assert.deepEqual(await invalidQuery.json(), { error: "invalid_request" });
    for (const path of [BILLING_PRESENTATION_ROUTE_PATH, BILLING_PLANS_ROUTE_PATH]) {
      const result = await readRawGet(origin, path, "{}");
      assert.equal(result.status, 400);
      assert.deepEqual(result.data, { error: "invalid_request" });
    }
  });
  assert.deepEqual(calls, ["authenticate", "authenticate", "authenticate"]);
});
test("unmatched method/path and unavailable optional read services return false without authenticating", async () => {
  const { router, calls } = fixture();
  for (const [method, path] of [
    ["POST", BILLING_PRESENTATION_ROUTE_PATH],
    ["POST", BILLING_PLANS_ROUTE_PATH],
    ["GET", "/v1/billing/recovery-credit-purchases"],
    ["POST", "/v1/billing/recovery-credit-purchases"],
    ["GET", "/v1/billing/subscription"],
    ["GET", "/v1/merchant/bootstrap"],
    ["GET", "/v1/billing/plans/unknown"],
  ]) {
    const handled = await router.handle({ method, url: path } as IncomingMessage, {} as ServerResponse);
    assert.equal(handled, false, `${method} ${path} must fall through`);
  }
  assert.deepEqual(calls, []);

  const missingBilling = fixture({ withoutBilling: true });
  const missingCatalogue = fixture({ withoutCatalogue: true });
  assert.equal(await missingBilling.router.handle({ method: "GET", url: BILLING_PRESENTATION_ROUTE_PATH } as IncomingMessage, {} as ServerResponse), false);
  assert.equal(await missingCatalogue.router.handle({ method: "GET", url: BILLING_PLANS_ROUTE_PATH } as IncomingMessage, {} as ServerResponse), false);
  assert.deepEqual(missingBilling.calls, []);
  assert.deepEqual(missingCatalogue.calls, []);
});
test("billing integrity errors and invalid projected responses retain 409/error/log contracts", async () => {
  for (const options of [
    { billingFailure: new BillingPresentationError("billing_operation_conflict"), code: "billing_operation_conflict" },
    { billingValue: { schemaVersion: 1 }, code: "billing_integrity_invalid" },
  ]) {
    const { router, events } = fixture(options);
    await withRouter(router, async (origin) => {
      const response = await fetch(`${origin}${BILLING_PRESENTATION_ROUTE_PATH}`, { headers: authorizedHeaders });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: options.code });
    });
    assert.deepEqual(events.map((event) => [event.level, event.name, event.data.reason]), [
      ["warn", "billing.presentation.read.failed", options.code],
    ]);
  }
});

test("unexpected billing or authentication errors are bounded and logged without sensitive details", async () => {
  for (const options of [
    { billingFailure: new Error("sensitive billing detail") },
    { authFailure: new Error("sensitive credential detail") },
  ]) {
    const { router, events } = fixture(options);
    await withRouter(router, async (origin) => {
      const response = await fetch(`${origin}${BILLING_PRESENTATION_ROUTE_PATH}`, { headers: authorizedHeaders });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "internal_error" });
    });
    assert.equal(events[0]?.name, "billing.presentation.read.failed");
    assert.equal(events[0]?.data.reason, "internal");
  }
});
