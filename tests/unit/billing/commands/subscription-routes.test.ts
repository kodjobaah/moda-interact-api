import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { RecurringBillingCommandError } from "../../../../src/billing/commands/recurring-subscription-command.service.js";
import {
  BILLING_SUBSCRIPTION_ROUTE_PATH as subscriptionPath,
  BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH as switchPath,
} from "../../../../src/billing/commands/routes.js";
import { authorizedHeaders, commandFixture, rawCommand, rawHeaders, withCommandRouter } from "./command-route-fixtures.js";

const planBody = JSON.stringify({ merchantPricingPlanId: "plan-12" });
const created = { schemaVersion: 1, operationId: "op-create", kind: "SUBSCRIPTION_CREATE", state: "AWAITING_CONFIRMATION", confirmationUrl: "https://provider.example/private" };
const confirmed = { ...created, state: "CONFIRMED" };

function recurringRecorder(calls: string[], reply: unknown = created) {
  return {
    async create(...args: unknown[]) { calls.push(`create:${(args[0] as { shopId: string }).shopId}:${args[1]}:${args[2]}`); return reply; },
    async switchPlan(...args: unknown[]) { calls.push(`switch:${(args[0] as { shopId: string }).shopId}:${args[1]}:${args[2]}`); return reply; },
    async cancel(...args: unknown[]) { calls.push(`cancel:${(args[0] as { shopId: string }).shopId}:${args[1]}`); return confirmed; },
  };
}

test("recurring create, switch and DELETE cancel use authenticated shop, status transitions and no-store headers", async () => {
  const serviceCalls: string[] = [];
  const { router, calls, events } = commandFixture({ recurring: recurringRecorder(serviceCalls) });
  await withCommandRouter(router, async (origin) => {
    for (const [path, method, expectedStatus, payload] of [
      [subscriptionPath, "POST", 202, planBody],
      [switchPath, "POST", 202, planBody],
      [subscriptionPath, "DELETE", 200, undefined],
    ] as const) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { ...authorizedHeaders, "x-shop-id": "spoofed-shop" },
        ...(payload ? { body: payload } : {}),
      });
      assert.equal(response.status, expectedStatus);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.deepEqual(await response.json(), expectedStatus === 200 ? confirmed : created);
    }
  });
  assert.deepEqual(serviceCalls, [
    "create:authenticated-shop:request-123:plan-12",
    "switch:authenticated-shop:request-123:plan-12",
    "cancel:authenticated-shop:request-123",
  ]);
  assert.deepEqual(calls, ["authenticate", "authenticate", "authenticate"]);
  assert.deepEqual(events.map((event) => event.name), ["billing.recurring.command", "billing.recurring.command", "billing.recurring.command"]);
  assert.ok(events.every((event) => event.data.shopId === "authenticated-shop" && event.data.durationMs === 0));
  assert.equal(JSON.stringify(events).includes("provider.example"), false);
  assert.equal(JSON.stringify(events).includes("spoofed-shop"), false);
});

test("recurring commands enforce a single Idempotency-Key header before reading request payload", async () => {
  const serviceCalls: string[] = [];
  const { router, calls } = commandFixture({ recurring: recurringRecorder(serviceCalls) });
  await withCommandRouter(router, async (origin) => {
    for (const headers of [
      rawHeaders().filter((_, index) => index !== 4 && index !== 5),
      [...rawHeaders(), "Idempotency-Key", "request-456"],
      rawHeaders("bad key"),
    ]) {
      const response = await rawCommand(origin, subscriptionPath, "POST", headers, planBody);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error: "invalid_idempotency_key" });
    }
    const accepted = await rawCommand(origin, subscriptionPath, "POST", rawHeaders("  valid.key-3  "), planBody);
    assert.equal(accepted.status, 202);
  });
  assert.deepEqual(serviceCalls, ["create:authenticated-shop:valid.key-3:plan-12"]);
  assert.deepEqual(calls, ["authenticate", "authenticate", "authenticate", "authenticate"]);
});

test("recurring commands preserve strict body fields, content type, query and no-body DELETE contract", async () => {
  const serviceCalls: string[] = [];
  const { router } = commandFixture({ recurring: recurringRecorder(serviceCalls) });
  await withCommandRouter(router, async (origin) => {
    for (const [path, method, headers, body, expected] of [
      [subscriptionPath, "POST", rawHeaders(), JSON.stringify({ merchantPricingPlanId: "plan-12", shopId: "forged" }), 400],
      [subscriptionPath, "POST", rawHeaders(), "[1,2]", 400],
      [subscriptionPath, "POST", [...rawHeaders().slice(0, -2), "Content-Type", "text/plain"], planBody, 400],
      [`${switchPath}?shopId=forged`, "POST", rawHeaders(), planBody, 400],
      [subscriptionPath, "POST", rawHeaders(), JSON.stringify({ merchantPricingPlanId: "p".repeat(129) }), 400],
      [subscriptionPath, "POST", rawHeaders(), "{", 400],
      [subscriptionPath, "POST", rawHeaders(), JSON.stringify({ merchantPricingPlanId: "p".repeat(9000) }), 413],
      [subscriptionPath, "DELETE", [...rawHeaders(), "Content-Length", "2"], "{}", 400],
      [subscriptionPath, "DELETE", [...rawHeaders(), "Content-Length", "0"], undefined, 200],
    ] as const) {
      const result = await rawCommand(origin, path, method, headers, body);
      assert.equal(result.status, expected, `${method} ${path}`);
      assert.deepEqual(result.body, expected === 200 ? confirmed : { error: expected === 413 ? "request_too_large" : "invalid_request" });
    }
  });
  assert.deepEqual(serviceCalls, ["cancel:authenticated-shop:request-123"]);
});

test("recurring provider-unavailable and known errors preserve status, safe error body and bounded log metadata", async () => {
  const unavailable = commandFixture();
  await withCommandRouter(unavailable.router, async (origin) => {
    const response = await fetch(`${origin}${subscriptionPath}`, { method: "POST", headers: authorizedHeaders, body: planBody });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "billing_provider_unavailable" });
  });
  assert.equal(unavailable.events[0]?.level, "warn");
  assert.equal(unavailable.events[0]?.data.reason, "billing_provider_unavailable");
  const errorService = {
    async create() { throw new RecurringBillingCommandError(502, "billing_provider_outcome_unknown", "op-safe", "PROVIDER_SAFE"); },
    async switchPlan() { throw new Error("secret internal provider information"); },
    async cancel() { throw new Error("must not be reached"); },
  };
  const { router, events } = commandFixture({ recurring: errorService });
  await withCommandRouter(router, async (origin) => {
    const known = await fetch(`${origin}${subscriptionPath}`, { method: "POST", headers: authorizedHeaders, body: planBody });
    assert.equal(known.status, 502);
    assert.deepEqual(await known.json(), { error: "billing_provider_outcome_unknown", operationId: "op-safe", providerErrorCode: "PROVIDER_SAFE" });
    const unexpected = await fetch(`${origin}${switchPath}`, { method: "POST", headers: authorizedHeaders, body: planBody });
    assert.equal(unexpected.status, 500);
    assert.deepEqual(await unexpected.json(), { error: "internal_error" });
  });
  assert.deepEqual(events.map((e) => [e.level, e.name, e.data.reason]), [
    ["warn", "billing.recurring.command.failed", "billing_provider_outcome_unknown"],
    ["error", "billing.recurring.command.failed", "internal"],
  ]);
  assert.equal(JSON.stringify(events).includes("PROVIDER_SAFE"), false);
  assert.equal(JSON.stringify(events).includes("secret internal provider information"), false);
});

test("recurring auth failures cannot reach provider services and unmatched methods always fall through", async () => {
  let invoked = 0;
  const recorder = {
    async create() { invoked++; return created; },
    async switchPlan() { invoked++; return created; },
    async cancel() { invoked++; return confirmed; },
  };
  const { router, calls } = commandFixture({ recurring: recorder });
  await withCommandRouter(router, async (origin) => {
    const response = await fetch(`${origin}${subscriptionPath}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "key" }, body: planBody,
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    const spoof = await fetch(`${origin}${subscriptionPath}?shopId=attacker`, { method: "POST", headers: authorizedHeaders, body: planBody });
    assert.equal(spoof.status, 400);
  });
  assert.equal(invoked, 0);
  assert.deepEqual(calls, ["authenticate", "authenticate"]);
  for (const [method, url] of [
    ["GET", subscriptionPath], ["GET", switchPath], ["PUT", subscriptionPath],
    ["GET", "/v1/billing/recovery-credit-purchases"], ["POST", "/v1/merchant/bootstrap"],
  ]) {
    assert.equal(await router.handle({ method, url } as IncomingMessage, {} as ServerResponse), false);
  }
});
