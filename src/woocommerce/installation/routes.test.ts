import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { loadRuntimeConfig } from "../../runtime-config.js";
import { MerchantBootstrapIntegrityError } from "../../merchant/bootstrap/bootstrap-read.service.js";
import { createApiRuntime } from "../../server.js";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "./authenticator.js";
import { digestSecret } from "./credential.js";
import {
  BILLING_PLANS_ROUTE_PATH,
  BILLING_PRESENTATION_ROUTE_PATH,
  BILLING_SUBSCRIPTION_ROUTE_PATH,
  BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH,
  createWooInstallationRoutes,
} from "./routes.js";
import { BillingPresentationError } from "../../billing/presentation/billing-read.service.js";
import { BillingCatalogueError } from "../../billing/presentation/plan-catalogue-read.service.js";
import { RecurringBillingCommandError } from "../../billing/commands/recurring-subscription-command.service.js";
import {
  FreePlanConfigurationUnavailableError,
  InitialFreeActivationConflictError,
} from "../billing/initial-free-activation.service.js";

const attemptId = "550e8400-e29b-41d4-a716-446655440000";
const bootstrapSecret = Buffer.alloc(32, 2).toString("base64url");
const installationCredential = Buffer.alloc(32, 7).toString("base64url");

async function withApi(
  callback: (baseUrl: string, logLines: string[], calls: string[]) => Promise<void>,
  probeFailure?: Error,
  bootstrapFailure?: Error,
  authenticatorOverride?: WooInstallationAuthenticator,
  connectionFailure?: Error,
  billingFailure?: Error,
  catalogueFailure?: Error,
  recurringCommandOverride?: object,
): Promise<void> {
  const logLines: string[] = [];
  const calls: string[] = [];
  const logger = createLogger({
    serviceName: "api-route-test",
    environment: "test",
    sink: (line) => logLines.push(JSON.stringify(line)),
  });
  const connectionService = {
    connect: async (input: { site: { canonicalSiteUrl: string } }) => {
      calls.push(`connect:${input.site.canonicalSiteUrl}`);
      if (connectionFailure) throw connectionFailure;
      return {
        installationId: "install_123",
        shopId: "shop_456",
        canonicalSiteUrl: input.site.canonicalSiteUrl,
        credential: installationCredential,
        credentialVersion: 1,
        connection: "CREATED" as const,
      };
    },
  };
  const authenticator = {
    authenticate: async (request: IncomingMessage) => {
      calls.push("authenticate");
      if (probeFailure) throw probeFailure;
      if (!request.headers["x-moda-installation-id"] || !request.headers.authorization) {
        throw new WooUnauthenticatedError();
      }
      return {
        installationId: "install_123",
        shopId: "shop_456",
        canonicalSiteUrl: "https://merchant.example",
        credentialVersion: 1,
      };
    },
  };
  const bootstrapReadService = {
    read: async (principal: { shopId: string }) => {
      calls.push(`bootstrap:${principal.shopId}`);
      if (bootstrapFailure) throw bootstrapFailure;
      return {
        schemaVersion: 1,
        shop: {
          id: principal.shopId,
          platform: "WOOCOMMERCE",
          domain: "https://merchant.example",
          onboardingCompleted: false,
          installedAt: "2026-10-02T10:00:00.000Z",
        },
        internationalContext: { storeLocale: "pt_BR", languageTag: null, timeZone: null, countryCode: null },
        storeProfile: { activeCategory: null, pendingCategory: null, pendingSelectionGeneration: 0, pendingSelectedAt: null },
      };
    },
  };
  const billingReadService = {
    read: async (principal: { shopId: string }) => {
      calls.push(`billing:${principal.shopId}`);
      if (billingFailure) throw billingFailure;
      return {
        schemaVersion: 1,
        experienceState: "ACTIVE",
        surfaces: {
          usageHistoryAllowed: true,
          purchaseHistoryAllowed: true,
          managePlansAllowed: true,
          cancelSubscriptionAllowed: false,
        },
        currentPlan: null,
        pendingPlan: null,
        pendingCancellation: null,
        capacity: {
          paidIncluded: null,
          freeLifetime: { granted: 5, committed: 1, reserved: 0, remaining: 4 },
          promotional: { granted: 0, committed: 0, reserved: 0, remaining: 0 },
          purchased: { granted: 0, committed: 0, reserved: 0, refunding: 0, available: 0 },
        },
        topUps: { configured: false, purchaseEligible: false, offers: [], latestPurchase: null, unresolvedPurchases: [] },
      };
    },
  };
  const billingPlanCatalogueReadService = {
    read: async (principal: { shopId: string }, locale?: string) => {
      calls.push(`plans:${principal.shopId}:${locale ?? "default"}`);
      if (catalogueFailure) throw catalogueFailure;
      return {
        schemaVersion: 1,
        resolvedLocale: "en",
        plans: [{
          merchantPricingPlanId: "mp_free",
          displayName: "Free",
          planKind: "FREE",
          cataloguePosition: 0,
          featured: false,
          localizedDescription: "Start free",
          includedRecoveryCredits: 5,
          allowancePeriod: "LIFETIME",
          billingPeriod: "EVERY_30_DAYS",
          recurringAmountMinor: 0,
          currency: "USD",
          highlights: [],
        }],
      };
    },
  };
  const routes = createWooInstallationRoutes({
    mode: "public",
    connectionService: connectionService as never,
    bootstrapReadService: bootstrapReadService as never,
    billingReadService: billingReadService as never,
    billingPlanCatalogueReadService: billingPlanCatalogueReadService as never,
    ...(recurringCommandOverride ? { recurringSubscriptionCommandService: recurringCommandOverride as never } : {}),
    authenticator: authenticatorOverride ?? authenticator as never,
    logger,
  });
  const runtime = createApiRuntime(
    { ...loadRuntimeConfig({ DATABASE_URL: "postgresql://user:secret@localhost:5432/moda" }), port: 0 },
    { probe: async () => undefined, disconnect: async () => undefined },
    logger,
    routes,
  );
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`, logLines, calls);
  } finally {
    await runtime.shutdown();
  }
}

function validConnectBody(): string {
  return JSON.stringify({
    siteUrl: "https://Example.COM/store/",
    attemptId,
    bootstrapSecret,
  });
}

test("invalid, unknown-field and oversized connect requests stop before service calls", async () => {
  await withApi(async (baseUrl, _logs, calls) => {
    const wrongType = await fetch(`${baseUrl}/v1/woocommerce/installations/connect`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: validConnectBody(),
    });
    assert.equal(wrongType.status, 400);

    const unknownField = await fetch(`${baseUrl}/v1/woocommerce/installations/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteUrl: "https://merchant.example",
        attemptId,
        bootstrapSecret,
        shopId: "caller-controlled",
      }),
    });
    assert.equal(unknownField.status, 400);

    const oversized = await fetch(`${baseUrl}/v1/woocommerce/installations/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteUrl: `https://merchant.example/${"a".repeat(8200)}`,
        attemptId,
        bootstrapSecret,
      }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(calls, []);
  });
});

test("connect returns the bounded response, canonical URL and no permissive CORS", async () => {
  await withApi(async (baseUrl, logs, calls) => {
    const response = await fetch(`${baseUrl}/v1/woocommerce/installations/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validConnectBody(),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await response.json(), {
      installationId: "install_123",
      shopId: "shop_456",
      canonicalSiteUrl: "https://example.com/store",
      credential: installationCredential,
      credentialVersion: 1,
      connection: "CREATED",
    });
    assert.deepEqual(calls, ["connect:https://example.com/store"]);
    const logsText = logs.join("\n");
    assert.equal(logsText.includes(bootstrapSecret), false);
    assert.equal(logsText.includes(installationCredential), false);
    assert.equal(logsText.includes("Example.COM/store"), false);
  });
});

test("connect returns stable bounded errors for Free configuration and activation conflicts", async () => {
  await withApi(async (baseUrl, logs) => {
    const response = await fetch(`${baseUrl}/v1/woocommerce/installations/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validConnectBody(),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "FREE_PLAN_CONFIGURATION_UNAVAILABLE" });
    const matchingLogs = logs.map((line) => JSON.parse(line) as {
      event: string;
      level: string;
      data?: Record<string, unknown>;
    }).filter((record) => record.event === "woocommerce.installation.connect.failed");
    assert.equal(matchingLogs.length, 1);
    assert.equal(matchingLogs[0]?.level, "error");
    assert.equal(matchingLogs[0]?.data?.reason, "free_plan_configuration_unavailable");
    assert.equal(matchingLogs[0]?.data?.errorCode, "FREE_PLAN_CONFIGURATION_UNAVAILABLE");
    assert.equal(matchingLogs[0]?.data?.configurationReason, "free_catalogue_missing");
    assert.ok(typeof matchingLogs[0]?.data?.durationMs === "number");
    assert.equal(logs.join("\n").includes(bootstrapSecret), false);
    assert.equal(logs.join("\n").includes(installationCredential), false);
    assert.equal(logs.join("\n").includes("Example.COM/store"), false);
  }, undefined, undefined, undefined, new FreePlanConfigurationUnavailableError("free_catalogue_missing"));

  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/woocommerce/installations/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validConnectBody(),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "INITIAL_FREE_ACTIVATION_CONFLICT" });
  }, undefined, undefined, undefined, new InitialFreeActivationConflictError());
});

test("authentication probe returns only the principal and generic unauthorized body", async () => {
  await withApi(async (baseUrl, _logs, calls) => {
    const valid = await fetch(`${baseUrl}/v1/woocommerce/installation`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), {
      installationId: "install_123",
      shopId: "shop_456",
      canonicalSiteUrl: "https://merchant.example",
      credentialVersion: 1,
    });
    const invalid = await fetch(`${baseUrl}/v1/woocommerce/installation`);
    assert.equal(invalid.status, 401);
    assert.deepEqual(await invalid.json(), { error: "unauthorized" });
    assert.deepEqual(calls, ["authenticate", "authenticate"]);
  });
});

test("authentication probe maps unexpected authenticator failures to internal error", async () => {
  await withApi(async (baseUrl, logs) => {
    const response = await fetch(`${baseUrl}/v1/woocommerce/installation`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
    assert.equal(logs.join("\n").includes("database details"), false);
  }, new Error("database details must not be logged"));
});

test("merchant bootstrap uses only the authenticated tenant and rejects caller tenant selection", async () => {
  await withApi(async (baseUrl, logs, calls) => {
    const response = await fetch(`${baseUrl}/v1/merchant/bootstrap`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
        "X-Shop-Id": "caller-controlled",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await response.json(), {
      schemaVersion: 1,
      shop: {
        id: "shop_456",
        platform: "WOOCOMMERCE",
        domain: "https://merchant.example",
        onboardingCompleted: false,
        installedAt: "2026-10-02T10:00:00.000Z",
      },
      internationalContext: { storeLocale: "pt_BR", languageTag: null, timeZone: null, countryCode: null },
      storeProfile: { activeCategory: null, pendingCategory: null, pendingSelectionGeneration: 0, pendingSelectedAt: null },
    });
    assert.deepEqual(calls, ["authenticate", "bootstrap:shop_456"]);
    const logText = logs.join("\n");
    assert.equal(logText.includes("caller-controlled"), false);
    assert.equal(logText.includes("merchant.example"), false);
    assert.equal(logText.includes("pt_BR"), false);
  });

  await withApi(async (baseUrl, _logs, calls) => {
    const response = await fetch(`${baseUrl}/v1/merchant/bootstrap?shopId=caller-controlled`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
    assert.deepEqual(calls, ["authenticate"]);
  });
});

test("merchant bootstrap authentication and integrity failures stay bounded", async () => {
  await withApi(async (baseUrl, _logs, calls) => {
    const unauthorized = await fetch(`${baseUrl}/v1/merchant/bootstrap`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });
    assert.deepEqual(calls, ["authenticate"]);
  });

  await withApi(async (baseUrl, logs) => {
    const response = await fetch(`${baseUrl}/v1/merchant/bootstrap`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
    assert.equal(logs.join("\n").includes("merchant bootstrap integrity failure"), false);
  }, undefined, new MerchantBootstrapIntegrityError());
});

test("merchant bootstrap HTTP route uses the API-002 authenticator principal as tenant identity", async () => {
  const authenticationQueries: unknown[] = [];
  const authenticator = new WooInstallationAuthenticator({
    wooCommerceInstallation: {
      findUnique: async (query: unknown) => {
        authenticationQueries.push(query);
        return {
          id: "install_123",
          shopId: "shop_456",
          canonicalSiteUrl: "https://merchant.example",
          status: "ACTIVE",
          credentialDigest: digestSecret(Buffer.from(installationCredential, "base64url")),
          credentialVersion: 1,
          revokedAt: null,
          shop: { status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null },
        };
      },
    },
  } as never);

  await withApi(async (baseUrl, _logs, calls) => {
    const response = await fetch(`${baseUrl}/v1/merchant/bootstrap`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
        "X-Shop-Id": "caller-controlled",
      },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { shop: { id: string } };
    assert.equal(body.shop.id, "shop_456");
    assert.deepEqual(calls, ["bootstrap:shop_456"]);
    assert.deepEqual(authenticationQueries.map((query) => (query as { where: unknown }).where), [{ id: "install_123" }]);
  }, undefined, undefined, authenticator);
});

test("billing routes authenticate, use only principal.shopId, and return private no-store responses", async () => {
  await withApi(async (baseUrl, logs, calls) => {
    const billing = await fetch(`${baseUrl}${BILLING_PRESENTATION_ROUTE_PATH}`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
        "X-Shop-Id": "caller-controlled",
      },
    });
    assert.equal(billing.status, 200);
    assert.equal(billing.headers.get("cache-control"), "no-store");
    assert.equal(billing.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(calls.slice(0, 2), ["authenticate", "billing:shop_456"]);
    assert.equal(logs.join("\n").includes("caller-controlled"), false);

    const plans = await fetch(`${baseUrl}${BILLING_PLANS_ROUTE_PATH}?locale=pt-BR`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
    });
    assert.equal(plans.status, 200);
    assert.equal(plans.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls.slice(2), ["authenticate", "plans:shop_456:pt-BR"]);
  });
});

test("billing routes reject unauthenticated requests and caller-controlled query parameters", async () => {
  await withApi(async (baseUrl, _logs, calls) => {
    const unauthenticated = await fetch(`${baseUrl}${BILLING_PRESENTATION_ROUTE_PATH}`);
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), { error: "unauthorized" });

    const tenantQuery = await fetch(`${baseUrl}${BILLING_PRESENTATION_ROUTE_PATH}?shopId=caller-controlled`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
    });
    assert.equal(tenantQuery.status, 400);
    assert.deepEqual(await tenantQuery.json(), { error: "invalid_request" });

    const unknownPlanQuery = await fetch(`${baseUrl}${BILLING_PLANS_ROUTE_PATH}?locale=en&shopId=caller-controlled`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
    });
    assert.equal(unknownPlanQuery.status, 400);
    assert.deepEqual(calls, ["authenticate", "authenticate", "authenticate"]);
  });
});

test("billing routes map service failures to bounded API errors", async () => {
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BILLING_PRESENTATION_ROUTE_PATH}`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "billing_operation_conflict" });
  }, undefined, undefined, undefined, undefined, new BillingPresentationError("billing_operation_conflict"));

  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BILLING_PLANS_ROUTE_PATH}?locale=en`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "billing_locale_invalid" });
  }, undefined, undefined, undefined, undefined, undefined, new BillingCatalogueError("billing_locale_invalid"));

  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BILLING_PLANS_ROUTE_PATH}?locale=en`, {
      headers: {
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "billing_catalogue_invalid" });
  }, undefined, undefined, undefined, undefined, undefined, new BillingCatalogueError("billing_catalogue_invalid"));
});

test("recurring command routes authenticate and expose only bounded command results", async () => {
  const responses = {
    create: { schemaVersion: 1, operationId: "op-create", kind: "SUBSCRIPTION_CREATE", state: "AWAITING_CONFIRMATION", confirmationUrl: "https://woocommerce.com/checkout" },
    switch: { schemaVersion: 1, operationId: "op-switch", kind: "PLAN_SWITCH", state: "AWAITING_CONFIRMATION", confirmationUrl: "https://woocommerce.com/switch" },
    cancel: { schemaVersion: 1, operationId: "op-cancel", kind: "CANCEL", state: "CONFIRMED", confirmationUrl: null },
  } as const;
  const commandCalls: string[] = [];
  const commandService = {
    create: async (principal: { shopId: string }, key: string, planId: string) => {
      commandCalls.push(`create:${principal.shopId}:${key}:${planId}`);
      return responses.create;
    },
    switchPlan: async (principal: { shopId: string }, key: string, planId: string) => {
      commandCalls.push(`switch:${principal.shopId}:${key}:${planId}`);
      return responses.switch;
    },
    cancel: async (principal: { shopId: string }, key: string) => {
      commandCalls.push(`cancel:${principal.shopId}:${key}`);
      return responses.cancel;
    },
  };

  await withApi(async (baseUrl, logs, calls) => {
    const headers = {
      "content-type": "application/json",
      "Idempotency-Key": "request-1",
      "X-Moda-Installation-Id": "install_123",
      Authorization: `Bearer ${installationCredential}`,
      "X-Shop-Id": "caller-controlled",
    };
    const create = await fetch(`${baseUrl}${BILLING_SUBSCRIPTION_ROUTE_PATH}`, {
      method: "POST", headers, body: JSON.stringify({ merchantPricingPlanId: "opaque-paid-id" }),
    });
    assert.equal(create.status, 202);
    assert.equal(create.headers.get("cache-control"), "no-store");
    assert.deepEqual(await create.json(), responses.create);

    const switched = await fetch(`${baseUrl}${BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH}`, {
      method: "POST", headers: { ...headers, "Idempotency-Key": "request-2" },
      body: JSON.stringify({ merchantPricingPlanId: "opaque-target-id" }),
    });
    assert.equal(switched.status, 202);
    assert.deepEqual(await switched.json(), responses.switch);

    const cancelled = await fetch(`${baseUrl}${BILLING_SUBSCRIPTION_ROUTE_PATH}`, {
      method: "DELETE", headers: { ...headers, "Idempotency-Key": "request-3", "content-type": "" },
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), responses.cancel);
    assert.deepEqual(commandCalls, [
      "create:shop_456:request-1:opaque-paid-id",
      "switch:shop_456:request-2:opaque-target-id",
      "cancel:shop_456:request-3",
    ]);
    assert.equal(calls.filter((call) => call === "authenticate").length, 3);
    assert.equal(logs.join("\n").includes("caller-controlled"), false);
    assert.equal(logs.join("\n").includes("woocommerce.com"), false);
  }, undefined, undefined, undefined, undefined, undefined, undefined, commandService);
});

test("recurring command routes reject missing keys, unknown fields, query parameters and DELETE bodies", async () => {
  await withApi(async (baseUrl, _logs, calls) => {
    const headers = {
      "content-type": "application/json",
      "X-Moda-Installation-Id": "install_123",
      Authorization: `Bearer ${installationCredential}`,
    };
    const missingKey = await fetch(`${baseUrl}${BILLING_SUBSCRIPTION_ROUTE_PATH}`, {
      method: "POST", headers, body: JSON.stringify({ merchantPricingPlanId: "opaque-paid-id" }),
    });
    assert.equal(missingKey.status, 400);
    assert.deepEqual(await missingKey.json(), { error: "invalid_idempotency_key" });

    const unknownField = await fetch(`${baseUrl}${BILLING_SUBSCRIPTION_ROUTE_PATH}`, {
      method: "POST", headers: { ...headers, "Idempotency-Key": "request-1" },
      body: JSON.stringify({ merchantPricingPlanId: "opaque-paid-id", price: 1 }),
    });
    assert.equal(unknownField.status, 400);

    const query = await fetch(`${baseUrl}${BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH}?shopId=other`, {
      method: "POST", headers: { ...headers, "Idempotency-Key": "request-2" },
      body: JSON.stringify({ merchantPricingPlanId: "opaque-target-id" }),
    });
    assert.equal(query.status, 400);

    const deleteBody = await fetch(`${baseUrl}${BILLING_SUBSCRIPTION_ROUTE_PATH}`, {
      method: "DELETE", headers: { ...headers, "Idempotency-Key": "request-3", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(deleteBody.status, 400);
    assert.deepEqual(calls, ["authenticate", "authenticate", "authenticate", "authenticate"]);
  });

  await withApi(async (baseUrl) => {
    const unavailable = await fetch(`${baseUrl}${BILLING_SUBSCRIPTION_ROUTE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "request-1", "X-Moda-Installation-Id": "install_123", Authorization: `Bearer ${installationCredential}` },
      body: JSON.stringify({ merchantPricingPlanId: "opaque-paid-id" }),
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "billing_provider_unavailable" });
  });
});

test("recurring command errors remain bounded and unauthorized requests never reach the service", async () => {
  const commandService = {
    create: async () => { throw new RecurringBillingCommandError(409, "billing_operation_failed", "operation-safe-id", "PROVIDER_REJECTED"); },
    switchPlan: async () => { throw new Error("must not be reached"); },
    cancel: async () => { throw new Error("must not be reached"); },
  };
  await withApi(async (baseUrl, logs) => {
    const response = await fetch(`${baseUrl}${BILLING_SUBSCRIPTION_ROUTE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "safe-key",
        "X-Moda-Installation-Id": "install_123",
        Authorization: `Bearer ${installationCredential}`,
      },
      body: JSON.stringify({ merchantPricingPlanId: "opaque-plan" }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "billing_operation_failed",
      operationId: "operation-safe-id",
      providerErrorCode: "PROVIDER_REJECTED",
    });
    assert.equal(logs.join("\n").includes("PROVIDER_REJECTED"), false);
  }, undefined, undefined, undefined, undefined, undefined, undefined, commandService);

  let reached = false;
  const forbiddenService = {
    create: async () => { reached = true; throw new Error("must not be reached"); },
    switchPlan: async () => { reached = true; throw new Error("must not be reached"); },
    cancel: async () => { reached = true; throw new Error("must not be reached"); },
  };
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BILLING_SUBSCRIPTION_ROUTE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "safe-key" },
      body: JSON.stringify({ merchantPricingPlanId: "opaque-plan" }),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }, undefined, undefined, { authenticate: async () => { throw new WooUnauthenticatedError(); } } as never, undefined, undefined, undefined, forbiddenService);
  assert.equal(reached, false);
});