import assert from "node:assert/strict";
import test from "node:test";
import { RecoveryCreditPurchaseCommandError } from "../../../../src/billing/commands/recovery-credit-purchase-command.service.js";
import { BILLING_RECOVERY_CREDIT_PURCHASES_ROUTE_PATH as purchasePath } from "../../../../src/billing/commands/routes.js";
import { authorizedHeaders, commandFixture, rawCommand, rawHeaders, withCommandRouter } from "./command-route-fixtures.js";

const purchaseBody = JSON.stringify({ merchantPricingUsageEventId: "credits-20" });
const pending = { schemaVersion: 1, purchaseId: "purchase-1", operationId: "operation-1", state: "AWAITING_CONFIRMATION", confirmationUrl: "https://provider.example/private" };
const confirmed = { ...pending, state: "CONFIRMED" };

test("recovery-credit POST uses authenticated shop, retains both status transitions and private response headers", async () => {
  const serviceCalls: string[] = [];
  let result = pending;
  const credit = { async initiate(...args: unknown[]) {
    serviceCalls.push(`${(args[0] as { shopId: string }).shopId}:${args[1]}:${args[2]}`);
    return result;
  } };
  const { router, calls, events } = commandFixture({ credit });
  await withCommandRouter(router, async (origin) => {
    for (const expected of [{ status: 202, value: pending }, { status: 200, value: confirmed }]) {
      const response = await fetch(`${origin}${purchasePath}`, {
        method: "POST", headers: { ...authorizedHeaders, "x-shop-id": "spoofed-shop" }, body: purchaseBody,
      });
      assert.equal(response.status, expected.status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.deepEqual(await response.json(), expected.value);
      result = confirmed;
    }
  });
  assert.deepEqual(serviceCalls, ["authenticated-shop:request-123:credits-20", "authenticated-shop:request-123:credits-20"]);
  assert.deepEqual(calls, ["authenticate", "authenticate"]);
  assert.deepEqual(events.map((event) => event.name), ["billing.recovery_credit_purchase.command", "billing.recovery_credit_purchase.command"]);
  assert.ok(events.every((event) => event.data.durationMs === 0 && event.data.shopId === "authenticated-shop"));
  assert.equal(JSON.stringify(events).includes("provider.example"), false);
  assert.equal(JSON.stringify(events).includes("spoofed-shop"), false);
});

test("recovery-credit rejects duplicate/missing idempotency headers before the command service", async () => {
  let invoked = 0;
  const { router, calls } = commandFixture({ credit: { async initiate() { invoked++; return pending; } } });
  await withCommandRouter(router, async (origin) => {
    for (const headers of [
      rawHeaders().filter((_, index) => index !== 4 && index !== 5),
      [...rawHeaders(), "Idempotency-Key", "second-key"],
      rawHeaders("invalid key"),
    ]) {
      const response = await rawCommand(origin, purchasePath, "POST", headers, purchaseBody);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error: "invalid_idempotency_key" });
    }
  });
  assert.equal(invoked, 0);
  assert.deepEqual(calls, ["authenticate", "authenticate", "authenticate"]);
});

test("recovery-credit strict decoding rejects unknown fields, malformed data, wrong content-type and oversized bodies", async () => {
  let invoked = 0;
  const { router } = commandFixture({ credit: { async initiate() { invoked++; return pending; } } });
  await withCommandRouter(router, async (origin) => {
    for (const [path, headers, body, expected] of [
      [purchasePath, rawHeaders(), JSON.stringify({ merchantPricingUsageEventId: "credits-20", quantity: 2 }), 400],
      [`${purchasePath}?shopId=forged`, rawHeaders(), purchaseBody, 400],
      [purchasePath, [...rawHeaders().slice(0, -2), "Content-Type", "text/plain"], purchaseBody, 400],
      [purchasePath, rawHeaders(), "{", 400],
      [purchasePath, rawHeaders(), JSON.stringify({ merchantPricingUsageEventId: "q".repeat(129) }), 400],
      [purchasePath, rawHeaders(), JSON.stringify({ merchantPricingUsageEventId: "q".repeat(9000) }), 413],
    ] as const) {
      const response = await rawCommand(origin, path, "POST", headers, body);
      assert.equal(response.status, expected);
      assert.deepEqual(response.body, { error: expected === 413 ? "request_too_large" : "invalid_request" });
    }
  });
  assert.equal(invoked, 0);
});

test("recovery-credit provider-unavailable, known provider failure and unexpected exception preserve safe responses", async () => {
  const unavailable = commandFixture();
  await withCommandRouter(unavailable.router, async (origin) => {
    const response = await fetch(`${origin}${purchasePath}`, { method: "POST", headers: authorizedHeaders, body: purchaseBody });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "billing_provider_unavailable" });
  });
  let throwsUnexpected = false;
  const { router, events } = commandFixture({ credit: { async initiate() {
    if (throwsUnexpected) throw new Error("credential and private provider body");
    throw new RecoveryCreditPurchaseCommandError(502, "billing_provider_outcome_unknown", "op-safe", "SAFE_PROVIDER", "purchase-safe");
  } } });
  await withCommandRouter(router, async (origin) => {
    const known = await fetch(`${origin}${purchasePath}`, { method: "POST", headers: authorizedHeaders, body: purchaseBody });
    assert.equal(known.status, 502);
    assert.deepEqual(await known.json(), {
      error: "billing_provider_outcome_unknown", operationId: "op-safe", providerErrorCode: "SAFE_PROVIDER", purchaseId: "purchase-safe",
    });
    throwsUnexpected = true;
    const unknown = await fetch(`${origin}${purchasePath}`, { method: "POST", headers: authorizedHeaders, body: purchaseBody });
    assert.equal(unknown.status, 500);
    assert.deepEqual(await unknown.json(), { error: "internal_error" });
  });
  assert.deepEqual(events.map((e) => [e.level, e.name, e.data.reason]), [
    ["warn", "billing.recovery_credit_purchase.command.failed", "billing_provider_outcome_unknown"],
    ["error", "billing.recovery_credit_purchase.command.failed", "internal"],
  ]);
  assert.equal(JSON.stringify(events).includes("SAFE_PROVIDER"), false);
  assert.equal(JSON.stringify(events).includes("credential and private provider body"), false);
});

test("recovery-credit auth failure does not reach command service; GET history remains a separate route", async () => {
  let invoked = 0;
  const { router, calls } = commandFixture({ credit: { async initiate() { invoked++; return pending; } } });
  await withCommandRouter(router, async (origin) => {
    const unauthorized = await fetch(`${origin}${purchasePath}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "safe-key" }, body: purchaseBody,
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });
    const history = await fetch(`${origin}${purchasePath}`);
    assert.equal(history.status, 404);
    assert.deepEqual(await history.json(), { error: "not_found" });
  });
  assert.equal(invoked, 0);
  assert.deepEqual(calls, ["authenticate"]);
});
