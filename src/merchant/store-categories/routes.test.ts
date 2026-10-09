import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createApiRuntime } from "../../server.js";
import { loadRuntimeConfig } from "../../runtime-config.js";
import { createWooInstallationRoutes } from "../../woocommerce/installation/routes.js";
import { WooUnauthenticatedError } from "../../woocommerce/installation/authenticator.js";
import { categoryPresentationLocale, StoreCategoryReadError } from "./locale.js";
import { createStoreCategoriesRoute, MERCHANT_STORE_CATEGORIES_ROUTE_PATH } from "./routes.js";

const authHeaders = {
  "x-moda-installation-id": "install_1",
  authorization: `Bearer ${"A".repeat(43)}`,
};
const readResult = {
  schemaVersion: 1,
  requestedLocale: "pt-BR",
  resolvedLocale: "pt-BR",
  categories: [],
  storeProfile: {
    activeCategory: null, pendingCategory: null, pendingSelectionGeneration: 0,
    pendingSelectedAt: null, activeMappingIds: [], pendingMappingIds: [], pendingState: "NONE", pendingTemplate: null,
  },
};

async function withServer(
  callback: (url: string, calls: string[], logs: string[]) => Promise<void>,
  options: { authFailure?: boolean; serviceFailure?: "conflict" | "internal" } = {},
): Promise<void> {
  const calls: string[] = [];
  const logs: string[] = [];
  const logger = createLogger({ serviceName: "store-categories-test", environment: "test", sink: (line) => logs.push(JSON.stringify(line)) });
  const authenticator = {
    authenticate: async (request: IncomingMessage) => {
      calls.push("authenticate");
      if (options.authFailure || !request.headers.authorization) throw new WooUnauthenticatedError();
      return { shopId: "shop_1", installationId: "install_1", canonicalSiteUrl: "https://shop.example", credentialVersion: 1 };
    },
  };
  const categoryRoute = createStoreCategoriesRoute({
    authenticator: authenticator as never,
    service: {
      read: async (principal: { shopId: string }, locale?: string) => {
        categoryPresentationLocale(locale);
        calls.push(`read:${principal.shopId}:${locale ?? "default"}`);
        if (options.serviceFailure === "conflict") throw new StoreCategoryReadError("store_category_integrity_invalid");
        if (options.serviceFailure === "internal") throw new Error("sensitive database details");
        return readResult;
      },
    } as never,
    logger,
  });
  const routes = createWooInstallationRoutes({
    mode: "public",
    connectionService: {} as never,
    bootstrapReadService: {} as never,
    storeContextService: {} as never,
    authenticator: authenticator as never,
    storeCategoriesRoute: categoryRoute,
    logger,
  });
  const runtime = createApiRuntime(
    { ...loadRuntimeConfig({ DATABASE_URL: "postgresql://user:pass@127.0.0.1/moda" }), port: 0 },
    { probe: async () => undefined, disconnect: async () => undefined }, logger, routes,
  );
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`, calls, logs);
  } finally {
    await runtime.shutdown();
  }
}

test("read-only route passes UI locale, uses authenticated shop and returns no-store", async () => {
  await withServer(async (base, calls, logs) => {
    const response = await fetch(`${base}${MERCHANT_STORE_CATEGORIES_ROUTE_PATH}?locale=pt_BR`, { headers: authHeaders });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), readResult);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(calls, ["authenticate", "read:shop_1:pt_BR"]);
    assert.equal(logs.some((line) => line.includes('"event":"merchant.store_categories.read"')), true);
    assert.equal(logs.join("\n").includes(authHeaders.authorization), false);
  });
});

test("unauthorized requests never reach the service", async () => {
  await withServer(async (base, calls) => {
    const response = await fetch(`${base}${MERCHANT_STORE_CATEGORIES_ROUTE_PATH}`, { headers: authHeaders });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.deepEqual(calls, ["authenticate"]);
  }, { authFailure: true });
});

test("query tampering, duplicate locale, request body and non-GET methods cannot read the catalogue", async () => {
  await withServer(async (base, calls) => {
    for (const query of ["?shopId=other", "?locale=en&locale=fr", "?locale=en&shopId=other", "?locale=%21%21"]) {
      const response = await fetch(`${base}${MERCHANT_STORE_CATEGORIES_ROUTE_PATH}${query}`, { headers: authHeaders });
      assert.equal(response.status, 400, query);
    }
    const body = await fetch(`${base}${MERCHANT_STORE_CATEGORIES_ROUTE_PATH}`, {
      method: "GET", headers: { ...authHeaders, "content-length": "0" },
    });
    assert.equal(body.status, 200);
    const post = await fetch(`${base}${MERCHANT_STORE_CATEGORIES_ROUTE_PATH}`, { method: "POST", headers: authHeaders });
    assert.equal(post.status, 404);
    assert.equal(calls.filter((call) => call.startsWith("read:")).length, 1);
  });
});

test("integrity conflict is 409 and unexpected exceptions are redacted as 500", async () => {
  for (const [kind, status, code] of [
    ["conflict", 409, "store_category_integrity_invalid"],
    ["internal", 500, "internal_error"],
  ] as const) {
    await withServer(async (base, calls, logs) => {
      const response = await fetch(`${base}${MERCHANT_STORE_CATEGORIES_ROUTE_PATH}`, { headers: authHeaders });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
      assert.equal(calls.filter((call) => call.startsWith("read:")).length, 1);
      assert.equal(logs.join("\n").includes("sensitive database details"), false);
    }, { serviceFailure: kind });
  }
});
