import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { composeApiRoutes } from "../../../src/composition/routes.js";
import type { ApiRouteHandler } from "../../../src/http/route-handler.js";
import { createApiRuntime } from "../../../src/server.js";

type RouteMatch = readonly [path: string, method: string];

function route(name: string, matches: readonly RouteMatch[], calls: string[]): ApiRouteHandler {
  return {
    async handle(request: IncomingMessage, response: ServerResponse) {
      calls.push(name);
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!matches.some(([path, method]) => path === url.pathname && method === request.method)) return false;
      response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ owner: name }));
      return true;
    },
  };
}

async function withRuntime(
  handlers: readonly ApiRouteHandler[],
  callback: (origin: string) => Promise<void>,
  probe: () => Promise<void> = async () => undefined,
): Promise<void> {
  const config: Parameters<typeof createApiRuntime>[0] = {
    databaseUrl: "postgresql://irrelevant:irrelevant@localhost/test",
    host: "0.0.0.0",
    port: 0,
    environment: "test",
    readinessTimeoutMs: 100,
    woocommerceConnectionMode: "public",
    wooBilling: null,
    wooRestReadAuthorization: null,
  };
  const logger = { info() {}, warn() {}, error() {} } as unknown as Parameters<typeof createApiRuntime>[2];
  const runtime = createApiRuntime(config, { probe, async disconnect() {} }, logger, handlers);
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await runtime.shutdown();
  }
}

/** The composition order is explicit, without a dependency on a Woo umbrella router. */
test("registers callbacks, webhook, merchant, billing and finally installation", () => {
  const calls: string[] = [];
  const rest = route("rest", [], calls);
  const webhook = route("webhook", [], calls);
  const merchant = [route("merchant-1", [], calls), route("merchant-2", [], calls)];
  const billing = [route("billing-1", [], calls), route("billing-2", [], calls)];
  const install = route("installation", [], calls);
  const activity = route("woo-activity", [], calls);
  const restore = route("woo-recovery-restore", [], calls);
  assert.deepEqual(composeApiRoutes({
    wooRestRead: rest, wooBillingWebhook: webhook, wooActivity: activity, wooRecoveryRestore: restore,
    merchant, billing, wooInstallation: install,
  }), [rest, webhook, activity, restore, ...merchant, ...billing, install]);
  assert.deepEqual(composeApiRoutes({
    wooBillingWebhook: webhook, merchant, billing, wooInstallation: install,
  }), [webhook, ...merchant, ...billing, install]);
});

test("all currently implemented route families remain individually reachable", async () => {
  const calls: string[] = [];
  const merchantDefinitions: readonly (readonly [string, readonly RouteMatch[]])[] = [
    ["recovery-summary", [["/v1/merchant/recovery-summary", "GET"]]],
    ["recovery-policy", [["/v1/merchant/recovery-policy", "GET"], ["/v1/merchant/recovery-policy", "PUT"]]],
    ["recoveries", [["/v1/merchant/recoveries", "GET"]]],
    ["recovery-detail", [["/v1/merchant/recoveries/recovery-123", "GET"]]],
    ["discount-offers", [["/v1/merchant/discount-catalogue", "GET"],
      ["/v1/merchant/discount-offers", "GET"], ["/v1/merchant/discount-offers", "PUT"]]],
    ["store-categories", [["/v1/merchant/store-categories", "GET"]]],
    ["store-category-selection", [["/v1/merchant/store-category", "POST"]]],
    ["bootstrap", [["/v1/merchant/bootstrap", "GET"]]],
    ["store-context", [["/v1/merchant/store-context", "PUT"]]],
  ];
  const billingDefinitions: readonly (readonly [string, readonly RouteMatch[]])[] = [
    ["purchase-history", [["/v1/billing/recovery-credit-purchases", "GET"]]],
    ["billing-reads", [["/v1/billing", "GET"], ["/v1/billing/plans", "GET"]]],
    ["billing-commands", [["/v1/billing/recovery-credit-purchases", "POST"],
      ["/v1/billing/subscription", "POST"], ["/v1/billing/subscription", "DELETE"],
      ["/v1/billing/subscription/switch", "POST"]]],
  ];
  const wooDefinitions: readonly (readonly [string, readonly RouteMatch[]])[] = [
    ["rest-read", [["/v1/woocommerce/read-authorizations", "POST"],
      ["/v1/woocommerce/read-authorization", "GET"], ["/v1/woocommerce/read-authorization", "DELETE"],
      ["/v1/woocommerce/read-authorizations/return", "GET"],
      [`/v1/woocommerce/read-authorizations/callback/${"a".repeat(43)}`, "POST"]]],
    ["billing-webhook", [["/v1/billing/webhooks/woocommerce", "POST"]]],
    ["recovery-restore", [["/v1/woocommerce/recovery-restore/resolve", "POST"]]],
    ["installation", [["/v1/woocommerce/installations/connect", "POST"],
      ["/v1/woocommerce/installation", "GET"]]],
  ];
  const definitions = [...wooDefinitions, ...merchantDefinitions, ...billingDefinitions];
  const handlers = composeApiRoutes({
    wooRestRead: route("rest-read", wooDefinitions[0]![1], calls),
    wooBillingWebhook: route("billing-webhook", wooDefinitions[1]![1], calls),
    wooRecoveryRestore: route("recovery-restore", wooDefinitions[2]![1], calls),
    merchant: merchantDefinitions.map(([name, matches]) => route(name, matches, calls)),
    billing: billingDefinitions.map(([name, matches]) => route(name, matches, calls)),
    wooInstallation: route("installation", wooDefinitions[3]![1], calls),
  });
  await withRuntime(handlers, async (origin) => {
    for (const [name, matches] of definitions) {
      for (const [path, method] of matches) {
        const response = await fetch(`${origin}${path}`, { method });
        assert.equal(response.status, 200, `${method} ${path}`);
        assert.deepEqual(await response.json(), { owner: name }, `${method} ${path}`);
      }
    }
    for (const [path, method] of [
      ["/v1/billing/recovery-credit-purchases", "PATCH"],
      ["/v1/woocommerce/installation", "POST"],
      ["/v1/merchant/store-category", "GET"],
      ["/v1/billing/subscription", "GET"],
    ] as const) {
      const response = await fetch(`${origin}${path}`, { method });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
  });
});

test("REST callback and signed webhook handlers win before installation and merchant handlers", async () => {
  const calls: string[] = [];
  const handlers = composeApiRoutes({
    wooRestRead: route("callback", [["/callback", "POST"]], calls),
    wooBillingWebhook: route("webhook", [["/webhook", "POST"]], calls),
    merchant: [route("merchant", [["/callback", "POST"], ["/webhook", "POST"]], calls)],
    billing: [],
    wooInstallation: route("installation", [["/callback", "POST"], ["/webhook", "POST"]], calls),
  });
  await withRuntime(handlers, async (origin) => {
    const callback = await fetch(`${origin}/callback`, { method: "POST" });
    assert.deepEqual(await callback.json(), { owner: "callback" });
    assert.deepEqual(calls.splice(0), ["callback"]);
    const webhook = await fetch(`${origin}/webhook`, { method: "POST" });
    assert.deepEqual(await webhook.json(), { owner: "webhook" });
    assert.deepEqual(calls.splice(0), ["callback", "webhook"]);
  });
});

test("health bypasses all route handlers; unclaimed routes are bounded 404", async () => {
  const calls: string[] = [];
  let probes = 0;
  const handlers = composeApiRoutes({
    wooBillingWebhook: route("webhook", [], calls),
    merchant: [route("merchant", [], calls)],
    billing: [route("billing", [], calls)],
    wooInstallation: route("installation", [], calls),
  });
  await withRuntime(handlers, async (origin) => {
    const live = await fetch(`${origin}/health/live`);
    assert.equal(live.status, 200);
    assert.equal(await live.text(), '{"status":"ok"}');
    const ready = await fetch(`${origin}/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal(await ready.text(), '{"status":"ready"}');
    assert.equal(probes, 1);
    assert.deepEqual(calls, []);
    const wrongMethod = await fetch(`${origin}/health/live`, { method: "POST" });
    assert.equal(wrongMethod.status, 404);
    assert.equal(await wrongMethod.text(), '{"error":"not_found"}');
    assert.deepEqual(calls, ["webhook", "merchant", "billing", "installation"]);
  }, async () => { probes += 1; });
});

test("a throwing route yields bounded 500 and cannot invoke later handlers", async () => {
  let laterCalls = 0;
  const handlers: readonly ApiRouteHandler[] = [
    { async handle() { throw new Error("sensitive provider key"); } },
    { async handle() { laterCalls += 1; return true; } },
  ];
  await withRuntime(handlers, async (origin) => {
    const response = await fetch(`${origin}/anything`);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), '{"error":"internal_error"}');
    assert.equal(laterCalls, 0);
  });
});
