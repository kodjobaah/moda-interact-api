import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../../src/auth/woo-installation/authenticator.js";
import { createBillingRoutes } from "../../../src/composition/billing.js";
import { createMerchantRoutes } from "../../../src/composition/merchant.js";
import { composeApiRoutes } from "../../../src/composition/routes.js";
import { createWooRoutes } from "../../../src/composition/woocommerce.js";
import type { RuntimeConfig } from "../../../src/runtime-config.js";
import { createApiRuntime } from "../../../src/server.js";

// Instantiate the production factories, not a list of simulated route handlers.
// Every protected request is denied before database/provider calls. A Prisma
// double deliberately has no query methods: accidentally performing work before
// installation authentication will fail this test.
const prisma = { wooCommerceBillingWebhookReceipt: {} } as unknown as PrismaClient;
const authenticator = {
  async authenticate(): Promise<never> { throw new WooUnauthenticatedError(); },
} as unknown as WooInstallationAuthenticator;
const logger = { info() {}, warn() {}, error() {} } as unknown as StructuredLogger;
const config: RuntimeConfig = {
  databaseUrl: "postgresql://unused:unused@localhost/unused",
  host: "0.0.0.0",
  port: 0,
  environment: "test",
  readinessTimeoutMs: 100,
  woocommerceConnectionMode: "public",
  wooBilling: null,
  // This is an inert configuration stub. No credential is stored or used:
  // the tests exercise only the route registration/unauthenticated boundary.
  wooRestReadAuthorization: {
    publicOrigin: "https://api.example.invalid",
    activeKeyId: "inert",
    keyring: {} as NonNullable<RuntimeConfig["wooRestReadAuthorization"]>["keyring"],
  },
};

const protectedRoutes: ReadonlyArray<readonly [method: string, path: string]> = [
  ["GET", "/v1/merchant/feature-preferences"],
  ["PUT", "/v1/merchant/feature-preferences"],
  ["GET", "/v1/merchant/recovery-summary"],
  ["GET", "/v1/merchant/recovery-policy"],
  ["PUT", "/v1/merchant/recovery-policy"],
  ["GET", "/v1/merchant/recoveries"],
  ["GET", "/v1/merchant/recoveries/example"],
  ["GET", "/v1/merchant/recoveries/example/messages"],
  ["GET", "/v1/merchant/recoveries/example/related"],
  ["GET", "/v1/merchant/merchant-knowledge"],
  ["GET", "/v1/merchant/discount-catalogue"],
  ["GET", "/v1/merchant/discount-offers"],
  ["PUT", "/v1/merchant/discount-offers"],
  ["GET", "/v1/merchant/store-categories"],
  ["POST", "/v1/merchant/store-category"],
  ["GET", "/v1/merchant/bootstrap"],
  ["PUT", "/v1/merchant/store-context"],
  ["GET", "/v1/billing/recovery-credit-purchases"],
  ["POST", "/v1/billing/recovery-credit-purchases"],
  ["GET", "/v1/billing"],
  ["GET", "/v1/billing/plans"],
  ["POST", "/v1/billing/subscription"],
  ["DELETE", "/v1/billing/subscription"],
  ["POST", "/v1/billing/subscription/switch"],
  ["GET", "/v1/woocommerce/installation"],
  ["POST", "/v1/woocommerce/read-authorizations"],
  ["GET", "/v1/woocommerce/read-authorization"],
  ["DELETE", "/v1/woocommerce/read-authorization"],
];

test("real domain composition registers every authenticated route and retains trust boundaries", async () => {
  const merchant = createMerchantRoutes({ prisma, authenticator, logger, environment: config.environment });
  const billing = createBillingRoutes({ prisma, authenticator, logger, wooBilling: config.wooBilling });
  const woo = createWooRoutes({ prisma, authenticator, logger, config });
  assert.equal(merchant.length, 11);
  assert.equal(billing.length, 3);
  assert.ok(woo.restRead, "REST-read callbacks must be registered when enabled");
  const handlers = composeApiRoutes({
    wooRestRead: woo.restRead,
    wooBillingWebhook: woo.billingWebhook,
    merchant,
    billing,
    wooInstallation: woo.installation,
  });
  assert.equal(handlers.length, 17);

  const database = { async probe() {}, async disconnect() {} };
  const runtime = createApiRuntime(config, database, logger, handlers);
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const [method, path] of protectedRoutes) {
      const result = await fetch(`${origin}${path}`, { method });
      assert.equal(result.status, 401, `${method} ${path} must use the installed shop principal`);
      assert.equal((await result.json() as { error: string }).error, "unauthorized", `${method} ${path}`);
    }

    // The unauthenticated connect route remains separate from bearer auth.
    const connection = await fetch(`${origin}/v1/woocommerce/installations/connect`, { method: "POST" });
    assert.equal(connection.status, 400);
    // Signed webhooks use raw request validation, not the merchant bearer.
    const webhook = await fetch(`${origin}/v1/billing/webhooks/woocommerce`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(webhook.status, 503); // Provider secret deliberately not configured.
    const returned = await fetch(`${origin}/v1/woocommerce/read-authorizations/return`);
    assert.equal(returned.status, 200);
    assert.match(returned.headers.get("content-type") ?? "", /text\/html/);
    const badCallback = await fetch(`${origin}/v1/woocommerce/read-authorizations/callback/invalid`, { method: "POST" });
    assert.equal(badCallback.status, 404);

    for (const [method, path] of [
      ["GET", "/v1/billing/subscription"],
      ["POST", "/v1/billing"],
      ["GET", "/v1/merchant/store-context"],
      ["POST", "/v1/woocommerce/installation"],
    ] as const) {
      const response = await fetch(`${origin}${path}`, { method });
      assert.equal(response.status, 404, `${method} ${path} must fall through`);
    }
  } finally {
    await runtime.shutdown();
  }
});
