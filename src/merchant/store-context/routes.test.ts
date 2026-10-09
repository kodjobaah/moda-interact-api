import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { loadRuntimeConfig } from "../../runtime-config.js";
import { createApiRuntime } from "../../server.js";
import { WooUnauthenticatedError } from "../../woocommerce/installation/authenticator.js";
import { createWooInstallationRoutes, MERCHANT_STORE_CONTEXT_ROUTE_PATH } from "../../woocommerce/installation/routes.js";
import { MerchantStoreContextConflictError } from "./store-context.service.js";
import type { MerchantStoreContextSnapshot } from "./schema.js";

const payload: MerchantStoreContextSnapshot = {
  schemaVersion: 1, storeLocale: "en_GB", languageTag: "en-GB", timeZone: "Europe/London", countryCode: "GB",
};
const url = MERCHANT_STORE_CONTEXT_ROUTE_PATH;
const authHeaders = { "x-moda-installation-id": "installation_1", authorization: `Bearer ${"a".repeat(43)}` };

async function withApi(
  callback: (base: string, calls: MerchantStoreContextSnapshot[], logs: string[]) => Promise<void>,
  config: { auth?: "allow" | "deny"; failure?: "conflict" | "internal" } = {},
): Promise<void> {
  const calls: MerchantStoreContextSnapshot[] = [];
  const logs: string[] = [];
  const logger = createLogger({ serviceName: "api-store-context-test", environment: "test", sink: (line) => logs.push(JSON.stringify(line)) });
  const routes = createWooInstallationRoutes({
    mode: "public",
    connectionService: {} as never,
    bootstrapReadService: { read: async () => ({}) } as never,
    storeContextService: { update: async (_principal: unknown, snapshot: MerchantStoreContextSnapshot) => {
      calls.push(snapshot);
      if (config.failure === "conflict") throw new MerchantStoreContextConflictError();
      if (config.failure === "internal") throw new Error("sensitive DB secret");
    } } as never,
    authenticator: { authenticate: async () => {
      if (config.auth === "deny") throw new WooUnauthenticatedError();
      return { installationId: "installation_1", shopId: "shop_1", canonicalSiteUrl: "https://woo.example", credentialVersion: 1 };
    } } as never,
    logger,
  });
  const runtime = createApiRuntime({ ...loadRuntimeConfig({ DATABASE_URL: "postgresql://user:secret@localhost/moda" }), port: 0 },
    { probe: async () => undefined, disconnect: async () => undefined }, logger, routes);
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`, calls, logs);
  } finally {
    await runtime.shutdown();
  }
}

function put(base: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${url}`, { method: "PUT", headers: { ...authHeaders, "content-type": "application/json", ...headers }, body });
}

function errorRecords(logs: string[]) {
  return logs.map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> })
    .filter((record) => record.event === "merchant.store_context.sync.failed");
}

test("PUT returns 204, no body, no CORS and a bounded semantic success log", async () => {
  await withApi(async (base, calls, logs) => {
    const response = await put(base, JSON.stringify(payload));
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(calls, [payload]);
    const success = logs.map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> })
      .find((entry) => entry.event === "merchant.store_context.sync");
    assert.equal(success?.data?.shopId, "shop_1");
    assert.equal(success?.data?.installationId, "installation_1");
    assert.equal(success?.data?.outcome, "success");
    for (const secret of [payload.storeLocale!, payload.timeZone!, authHeaders.authorization, "Bearer"]) {
      assert.equal(logs.join("\n").includes(secret), false);
    }
  });
});

test("invalid JSON, bounds, types, missing/extra keys, media types and query parameters do not write", async () => {
  await withApi(async (base, calls, logs) => {
    const bodies = ["not-json", "[]", "{}", JSON.stringify({ ...payload, shopId: "other" }),
      JSON.stringify({ ...payload, timeZone: "+01:00" }), JSON.stringify({ ...payload, countryCode: "gb" }),
      JSON.stringify({ ...payload, storeLocale: "" }), JSON.stringify({ ...payload, schemaVersion: 2 })];
    for (const body of bodies) {
      const response = await put(base, body);
      assert.equal(response.status, 400, body);
      assert.deepEqual(await response.json(), { error: "invalid_request" });
    }
    const wrongMedia = await put(base, JSON.stringify(payload), { "content-type": "text/plain" });
    assert.equal(wrongMedia.status, 400);
    const unsupportedEncoding = await put(base, JSON.stringify(payload), { "content-encoding": "gzip" });
    assert.equal(unsupportedEncoding.status, 400);
    const query = await fetch(`${base}${url}?shopId=other`, {
      method: "PUT", headers: { ...authHeaders, "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    assert.equal(query.status, 400);
    const tooLarge = await put(base, JSON.stringify({ ...payload, storeLocale: "x".repeat(2200) }));
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { error: "request_too_large" });
    assert.deepEqual(calls, []);
    assert.ok(errorRecords(logs).length >= bodies.length);
  });
});

test("unauthorized request fails before any write", async () => {
  await withApi(async (base, calls, logs) => {
    const response = await put(base, JSON.stringify(payload));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.deepEqual(calls, []);
    assert.equal(errorRecords(logs)[0]?.data?.reason, "unauthorized");
    assert.equal(errorRecords(logs)[0]?.data?.shopId, undefined);
  }, { auth: "deny" });
});

test("Shop/installation conflict fails with 409; unexpected errors with bounded 500", async () => {
  for (const [failure, status, code, reason] of [
    ["conflict", 409, "store_context_conflict", "tenant_conflict"],
    ["internal", 500, "internal_error", "internal"],
  ] as const) {
    await withApi(async (base, calls, logs) => {
      const response = await put(base, JSON.stringify(payload));
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
      assert.equal(calls.length, 1);
      assert.equal(errorRecords(logs)[0]?.data?.reason, reason);
      assert.equal(logs.join("\n").includes("sensitive DB secret"), false);
    }, { failure });
  }
});

test("other methods cannot update store context", async () => {
  await withApi(async (base, calls) => {
    const response = await fetch(`${base}${url}`, { method: "GET", headers: authHeaders });
    assert.equal(response.status, 404);
    assert.deepEqual(calls, []);
  });
});
