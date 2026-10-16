import assert from "node:assert/strict";
import test from "node:test";
import { BillingPresentationError } from "../../../../src/billing/presentation/billing-read.service.js";
import { BillingCatalogueError } from "../../../../src/billing/presentation/plan-catalogue-read.service.js";
import { BILLING_PLANS_ROUTE_PATH } from "../../../../src/billing/presentation/routes.js";
import { authorizedHeaders, catalogueResponse, fixture, withRouter } from "./route-fixtures.js";

test("plans read retains locale forwarding, v1 response headers and log fields", async () => {
  const { router, calls, events } = fixture();
  await withRouter(router, async (origin) => {
    const response = await fetch(`${origin}${BILLING_PLANS_ROUTE_PATH}?locale=pt-BR`, { headers: authorizedHeaders });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), catalogueResponse);
  });
  assert.deepEqual(calls, ["authenticate", "plans:verified-shop:pt-BR"]);
  assert.deepEqual(events, [{
    level: "info", name: "billing.plans.read", data: {
      shopId: "verified-shop", resolvedLocale: "en", returnedPlanCount: 1, outcome: "success", durationMs: 0,
    },
  }]);
});
test("plans GET rejects duplicated locale and unknown query names before calling service", async () => {
  const { router, calls } = fixture();
  await withRouter(router, async (origin) => {
    for (const query of ["?locale=en&locale=fr", "?locale=en&shopId=spoofed-shop", "?x=1", "?locale=en&locale=fr&locale=de"]) {
      const response = await fetch(`${origin}${BILLING_PLANS_ROUTE_PATH}${query}`, { headers: authorizedHeaders });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_request" });
    }
  });
  assert.deepEqual(calls, ["authenticate", "authenticate", "authenticate", "authenticate"]);
});
test("plans locale errors return 400 without warning; catalogue and billing integrity errors return 409 with warning", async () => {
  for (const [error, status, code, warnings] of [
    [new BillingCatalogueError("billing_locale_invalid"), 400, "billing_locale_invalid", 0],
    [new BillingCatalogueError("billing_catalogue_translation_unavailable"), 409, "billing_catalogue_translation_unavailable", 1],
    [new BillingPresentationError("billing_integrity_invalid"), 409, "billing_integrity_invalid", 1],
  ] as const) {
    const { router, events } = fixture({ catalogueFailure: error });
    await withRouter(router, async (origin) => {
      const response = await fetch(`${origin}${BILLING_PLANS_ROUTE_PATH}`, { headers: authorizedHeaders });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
    });
    assert.equal(events.filter((event) => event.level === "warn").length, warnings);
  }
});
test("plans rejects invalid projected schema as billing_catalogue_invalid", async () => {
  const { router, events } = fixture({ catalogueValue: { schemaVersion: 1, resolvedLocale: "en", plans: [{ unexpected: true }] } });
  await withRouter(router, async (origin) => {
    const response = await fetch(`${origin}${BILLING_PLANS_ROUTE_PATH}`, { headers: authorizedHeaders });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "billing_catalogue_invalid" });
  });
  assert.equal(events[0]?.data.reason, "billing_catalogue_invalid");
});

test("unexpected catalogue failures use a bounded 500 error without exposing detail", async () => {
  const { router, events } = fixture({ catalogueFailure: new Error("sensitive catalogue detail") });
  await withRouter(router, async (origin) => {
    const response = await fetch(`${origin}${BILLING_PLANS_ROUTE_PATH}`, { headers: authorizedHeaders });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
  });
  assert.equal(events[0]?.name, "billing.plans.read.failed");
  assert.equal(events[0]?.data.reason, "internal");
});
