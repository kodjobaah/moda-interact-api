import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { loadRuntimeConfig } from "../../runtime-config.js";
import { createApiRuntime } from "../../server.js";
import { WooUnauthenticatedError } from "./authenticator.js";
import { createWooInstallationRoutes } from "./routes.js";

const attemptId = "550e8400-e29b-41d4-a716-446655440000";
const bootstrapSecret = Buffer.alloc(32, 2).toString("base64url");
const installationCredential = Buffer.alloc(32, 7).toString("base64url");

async function withApi(
  callback: (baseUrl: string, logLines: string[], calls: string[]) => Promise<void>,
  probeFailure?: Error,
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
  const routes = createWooInstallationRoutes({
    mode: "public",
    connectionService: connectionService as never,
    authenticator: authenticator as never,
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