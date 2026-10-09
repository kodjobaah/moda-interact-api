import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createApiRuntime } from "../../server.js";
import { loadRuntimeConfig } from "../../runtime-config.js";
import { createWooInstallationRoutes } from "../../woocommerce/installation/routes.js";
import { WooUnauthenticatedError } from "../../woocommerce/installation/authenticator.js";
import { StoreCategorySelectionError } from "./selection-errors.js";
import { createStoreCategorySelectionRoute, MERCHANT_STORE_CATEGORY_SELECTION_ROUTE_PATH } from "./selection-routes.js";

const auth = { "x-moda-installation-id": "install_1", authorization: `Bearer ${"A".repeat(43)}` };
const valid = { schemaVersion: 1, categoryId: "cat_1", selectedMappingIds: ["map_1"], expectedPendingSelectionGeneration: 0 };
const success = { schemaVersion: 1, activeCategoryId: "cat_1", activePromptRevisionId: "rev_1", activeMappingIds: ["map_1"], pendingSelectionGeneration: 1 };

type Failure = "auth" | "unavailable" | "conflict" | "inactive" | "revoked" | "internal";

async function withRuntime(
  run: (baseUrl: string, calls: string[], logs: string[]) => Promise<void>,
  failure?: Failure,
): Promise<void> {
  const calls: string[] = [];
  const logs: string[] = [];
  const logger = createLogger({ serviceName: "category-select-test", environment: "test", sink: (line) => logs.push(JSON.stringify(line)) });
  const authenticator = {
    authenticate: async (request: IncomingMessage) => {
      calls.push("authenticate");
      if (failure === "auth" || !request.headers.authorization) throw new WooUnauthenticatedError();
      return { shopId: "shop_1", installationId: "install_1", canonicalSiteUrl: "https://woo.example", credentialVersion: 1 };
    },
  };
  const selection = createStoreCategorySelectionRoute({
    authenticator: authenticator as never,
    service: { select: async (principal: { shopId: string }, input: unknown) => {
      calls.push(`select:${principal.shopId}`);
      assert.deepEqual(input, valid);
      if (failure === "unavailable") throw new StoreCategorySelectionError("category_unavailable");
      if (failure === "conflict" || failure === "revoked") throw new StoreCategorySelectionError("store_category_conflict");
      if (failure === "inactive") throw new StoreCategorySelectionError("subscription_not_active");
      if (failure === "internal") throw new Error("secret connection details");
      return success;
    } } as never,
    logger,
  });
  const routes = createWooInstallationRoutes({
    mode: "public", connectionService: {} as never, bootstrapReadService: {} as never,
    storeContextService: {} as never, authenticator: authenticator as never,
    storeCategorySelectionRoute: selection, logger,
  });
  const runtime = createApiRuntime(
    { ...loadRuntimeConfig({ DATABASE_URL: "postgresql://user:pass@127.0.0.1/moda" }), port: 0 },
    { probe: async () => undefined, disconnect: async () => undefined }, logger, routes,
  );
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, calls, logs);
  } finally {
    await runtime.shutdown();
  }
}

function post(base: string, value: unknown = valid, extras: { path?: string; headers?: Record<string, string>; raw?: string } = {}) {
  return fetch(`${base}${MERCHANT_STORE_CATEGORY_SELECTION_ROUTE_PATH}${extras.path ?? ""}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", ...extras.headers },
    body: extras.raw ?? JSON.stringify(value),
  });
}

test("API-006 POST authenticates, routes, logs metadata and returns authoritative generation", async () => {
  await withRuntime(async (base, calls, logs) => {
    const response = await post(base);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), success);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls, ["authenticate", "select:shop_1"]);
    assert.ok(logs.some((line) => line.includes('"event":"merchant.store_category.select"')));
    assert.equal(logs.join(" ").includes(auth.authorization), false);
    const read = await fetch(`${base}${MERCHANT_STORE_CATEGORY_SELECTION_ROUTE_PATH}`, { headers: auth });
    assert.equal(read.status, 404);
    assert.deepEqual(calls, ["authenticate", "select:shop_1"]);
  });
});

test("unauthorized request never parses or publishes", async () => {
  await withRuntime(async (base, calls) => {
    const result = await post(base);
    assert.equal(result.status, 401);
    assert.deepEqual(await result.json(), { error: "unauthorized" });
    assert.deepEqual(calls, ["authenticate"]);
  }, "auth");
});

test("invalid, oversized and tampered bodies never call the selection service", async () => {
  await withRuntime(async (base, calls) => {
    for (const payload of [
      { ...valid, shopId: "other" }, { ...valid, selectedMappingIds: ["map_1", "map_1"] },
      { ...valid, expectedPendingSelectionGeneration: -1 },
      { ...valid, schemaVersion: 2 },
    ]) {
      const result = await post(base, payload);
      assert.equal(result.status, 400);
    }
    for (const extra of [
      { path: "?shopId=other" },
      { headers: { "content-type": "text/plain" } },
      { raw: "{invalid" },
    ]) {
      const result = await post(base, valid, extra);
      assert.equal(result.status, 400);
    }
    const large = await post(base, valid, { raw: JSON.stringify({ ...valid, extra: "X".repeat(5000) }) });
    assert.equal(large.status, 413);
    assert.equal(calls.filter((call) => call.startsWith("select:")).length, 0);
  });
});

test("bounded category, generation, billing and internal failures have no sensitive payload", async () => {
  for (const [kind, status, code] of [
    ["unavailable", 422, "category_unavailable"], ["conflict", 409, "store_category_conflict"],
    ["inactive", 409, "subscription_not_active"], ["revoked", 409, "store_category_conflict"],
    ["internal", 500, "internal_error"],
  ] as const) {
    await withRuntime(async (base, calls, logs) => {
      const response = await post(base);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
      assert.equal(calls.filter((call) => call.startsWith("select:")).length, 1);
      assert.equal(logs.join(" ").includes("secret connection details"), false);
    }, kind);
  }
});
