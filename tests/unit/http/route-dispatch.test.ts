import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import type { ApiRouteHandler } from "../../../src/http/route-handler.js";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createWooPurchaseHistoryRoute } from "../../../src/billing/purchase-history/routes.js";
import { loadRuntimeConfig } from "../../../src/runtime-config.js";
import { createApiRuntime } from "../../../src/server.js";
import { WooUnauthenticatedError } from "../../../src/auth/woo-installation/authenticator.js";
import {
  createBillingCommandRoutes,
  BILLING_RECOVERY_CREDIT_PURCHASES_ROUTE_PATH,
} from "../../../src/billing/commands/routes.js";

const logger = createLogger({
  serviceName: "api-route-characterization-test",
  environment: "test",
  sink: () => undefined,
});

type Handler = ApiRouteHandler;

async function withApi(
  callback: (origin: string) => Promise<void>,
  options: { read?: Handler; webhook?: Handler; installation?: Handler; handlers?: readonly Handler[]; probe?: () => Promise<void> } = {},
): Promise<void> {
  const runtime = createApiRuntime(
    { ...loadRuntimeConfig({ DATABASE_URL: "postgresql://user:nonsecret@localhost:5432/test" }), port: 0 },
    { probe: options.probe ?? (async () => undefined), disconnect: async () => undefined },
    logger,
    options.handlers ?? [options.read, options.webhook, options.installation].filter(
      (handler): handler is Handler => handler !== undefined,
    ),
  );
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await runtime.shutdown();
  }
}

function respondingHandler(name: string, calls: string[], handled: boolean): Handler {
  return {
    async handle(_request, response) {
      calls.push(name);
      if (handled) {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ owner: name }));
      }
      return handled;
    },
  };
}

test("server gives REST-read callbacks precedence over billing webhook and installation routers", async () => {
  const calls: string[] = [];
  await withApi(async (origin) => {
    const response = await fetch(`${origin}/v1/woocommerce/read-authorizations/callback/${"a".repeat(43)}`, {
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { owner: "rest-read" });
  }, {
    read: respondingHandler("rest-read", calls, true),
    webhook: respondingHandler("webhook", calls, true),
    installation: respondingHandler("installation", calls, true),
  });
  assert.deepEqual(calls, ["rest-read"]);
});

test("server falls through in order and does not invoke the installation router after webhook accepts", async () => {
  const calls: string[] = [];
  await withApi(async (origin) => {
    const response = await fetch(`${origin}/v1/billing/webhooks/woocommerce`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { owner: "webhook" });
  }, {
    read: respondingHandler("rest-read", calls, false),
    webhook: respondingHandler("webhook", calls, true),
    installation: respondingHandler("installation", calls, true),
  });
  assert.deepEqual(calls, ["rest-read", "webhook"]);
});

test("server falls through all routers to bounded 404 when none claims the method and path", async () => {
  const calls: string[] = [];
  await withApi(async (origin) => {
    const response = await fetch(`${origin}/v1/billing/recovery-credit-purchases`, { method: "PATCH" });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(await response.text(), '{"error":"not_found"}');
  }, {
    read: respondingHandler("rest-read", calls, false),
    webhook: respondingHandler("webhook", calls, false),
    installation: respondingHandler("installation", calls, false),
  });
  assert.deepEqual(calls, ["rest-read", "webhook", "installation"]);
});

test("health GETs bypass routers but a wrong-method health request follows normal dispatch", async () => {
  const calls: string[] = [];
  let probeCount = 0;
  await withApi(async (origin) => {
    const live = await fetch(`${origin}/health/live`);
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("cache-control"), "no-store");
    assert.equal(await live.text(), '{"status":"ok"}');
    assert.equal(probeCount, 0);

    const ready = await fetch(`${origin}/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal(await ready.text(), '{"status":"ready"}');
    assert.equal(probeCount, 1);
    assert.deepEqual(calls, []);

    const wrongMethod = await fetch(`${origin}/health/live`, { method: "POST" });
    assert.equal(wrongMethod.status, 404);
    assert.deepEqual(await wrongMethod.json(), { error: "not_found" });
  }, {
    read: respondingHandler("rest-read", calls, false),
    webhook: respondingHandler("webhook", calls, false),
    installation: respondingHandler("installation", calls, false),
    probe: async () => { probeCount += 1; },
  });
  assert.deepEqual(calls, ["rest-read", "webhook", "installation"]);
});

test("recovery-credit purchases GET belongs to purchase history, POST to purchase command, other methods to neither", async () => {
  const calls: string[] = [];
  const principal = {
    installationId: "installation-a",
    shopId: "shop-a",
    canonicalSiteUrl: "https://merchant.example",
    credentialVersion: 4,
  };
  const authenticator = {
    authenticate: async (request: IncomingMessage) => {
      calls.push("authenticate");
      if (request.headers.authorization !== "Bearer test-credential") throw new WooUnauthenticatedError();
      return principal;
    },
  };
  const history = createWooPurchaseHistoryRoute({
    authenticator: authenticator as never,
    service: {
      read: async (who: { shopId: string }, query: { filter: string; page: number; pageSize: number }) => {
        calls.push(`history:${who.shopId}:${query.filter}:${query.page}:${query.pageSize}`);
        return {
          schemaVersion: 1, ...query, total: 20, totalPages: 2, purchases: [],
          refundRequest: {
            method: "WOOCOMMERCE_ORDERS", url: "https://woocommerce.com/my-account/orders/",
          },
        };
      },
    } as never,
    logger,
  });
  const commands = createBillingCommandRoutes({
    authenticator: authenticator as never,
    recoveryCreditPurchaseCommandService: {
      initiate: async (who: { shopId: string }, key: string, eventId: string) => {
        calls.push(`purchase:${who.shopId}:${key}:${eventId}`);
        return {
          schemaVersion: 1,
          state: "AWAITING_CONFIRMATION",
          purchaseId: "purchase-a",
          operationId: "operation-a",
          confirmationUrl: "https://woocommerce.com/checkout/operation-a",
        };
      },
    } as never,
    logger,
  });

  const path = BILLING_RECOVERY_CREDIT_PURCHASES_ROUTE_PATH;
  await withApi(async (origin) => {
    const denied = await fetch(`${origin}${path}`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "unauthorized" });

    const get = await fetch(`${origin}${path}?page=2&pageSize=10&filter=REFUNDED`, {
      headers: { authorization: "Bearer test-credential" },
    });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("cache-control"), "private, no-store");
    const historyBody = await get.json() as Record<string, unknown>;
    assert.equal(historyBody.page, 2);
    assert.deepEqual(historyBody.purchases, []);

    const post = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-credential",
        "idempotency-key": "recovery-credit-request-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ merchantPricingUsageEventId: "usage-event-a" }),
    });
    assert.equal(post.status, 202);
    assert.equal(post.headers.get("cache-control"), "no-store");
    assert.deepEqual(await post.json(), {
      schemaVersion: 1,
      state: "AWAITING_CONFIRMATION",
      purchaseId: "purchase-a",
      operationId: "operation-a",
      confirmationUrl: "https://woocommerce.com/checkout/operation-a",
    });

    const wrong = await fetch(`${origin}${path}`, {
      method: "PUT",
      headers: { authorization: "Bearer test-credential" },
    });
    assert.equal(wrong.status, 404);
    assert.deepEqual(await wrong.json(), { error: "not_found" });
  }, { handlers: [history, commands] });
  assert.deepEqual(calls, [
    "authenticate", // Denied GET, without invoking either business service.
    "authenticate", "history:shop-a:REFUNDED:2:10",
    "authenticate", "purchase:shop-a:recovery-credit-request-1:usage-event-a",
  ]);
});
