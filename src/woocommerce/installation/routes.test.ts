import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { loadRuntimeConfig } from "../../runtime-config.js";
import { MerchantBootstrapIntegrityError } from "../../merchant/bootstrap/bootstrap-read.service.js";
import { createApiRuntime } from "../../server.js";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "./authenticator.js";
import { digestSecret } from "./credential.js";
import { createWooInstallationRoutes } from "./routes.js";

const attemptId = "550e8400-e29b-41d4-a716-446655440000";
const bootstrapSecret = Buffer.alloc(32, 2).toString("base64url");
const installationCredential = Buffer.alloc(32, 7).toString("base64url");

async function withApi(
  callback: (baseUrl: string, logLines: string[], calls: string[]) => Promise<void>,
  probeFailure?: Error,
  bootstrapFailure?: Error,
  authenticatorOverride?: WooInstallationAuthenticator,
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
  const routes = createWooInstallationRoutes({
    mode: "public",
    connectionService: connectionService as never,
    bootstrapReadService: bootstrapReadService as never,
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