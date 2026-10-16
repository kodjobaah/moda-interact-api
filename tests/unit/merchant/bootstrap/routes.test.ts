import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";
import { MerchantBootstrapIntegrityError, MerchantBootstrapReadService } from "../../../../src/merchant/bootstrap/bootstrap-read.service.js";
import { createMerchantBootstrapRoute, MERCHANT_BOOTSTRAP_ROUTE_PATH } from "../../../../src/merchant/bootstrap/routes.js";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";

const principal = {
  installationId: "installation_verified",
  shopId: "shop_verified",
  canonicalSiteUrl: "https://merchant.example",
  credentialVersion: 2,
};
const authHeaders = {
  "x-moda-installation-id": principal.installationId,
  authorization: "Bearer private-credential",
};
const shopRow = {
  id: principal.shopId,
  domain: principal.canonicalSiteUrl,
  platform: "WOOCOMMERCE",
  shopifyShopId: null,
  status: "ACTIVE",
  onboardingCompleted: false,
  installedAt: new Date("2026-10-02T10:00:00.000Z"),
  storeLocale: "pt_BR",
  defaultLanguageTag: "pt-BR",
  defaultTimeZone: "America/Sao_Paulo",
  defaultCountryCode: "BR",
  commerceShopProfile: null,
};

type Event = { level: "info" | "warn" | "error"; name: string; data: Record<string, unknown> };

function fixture(options: { authFailure?: Error; readFailure?: Error; shop?: unknown } = {}) {
  const calls: string[] = [];
  const databaseQueries: unknown[] = [];
  const events: Event[] = [];
  let writes = 0;
  const authenticator = {
    async authenticate(request: IncomingMessage) {
      calls.push("authenticate");
      if (options.authFailure) throw options.authFailure;
      if (request.headers.authorization !== authHeaders.authorization ||
        request.headers["x-moda-installation-id"] !== principal.installationId) {
        throw new WooUnauthenticatedError();
      }
      return principal;
    },
  };
  const database = {
    shop: {
      async findUnique(query: unknown) {
        calls.push("read-shop");
        databaseQueries.push(query);
        if (options.readFailure) throw options.readFailure;
        return options.shop === undefined ? shopRow : options.shop;
      },
      async update() { writes += 1; throw new Error("writes not allowed"); },
      async create() { writes += 1; throw new Error("writes not allowed"); },
    },
  };
  const logger = {
    info(name: string, data: Record<string, unknown>) { events.push({ level: "info", name, data }); },
    warn(name: string, data: Record<string, unknown>) { events.push({ level: "warn", name, data }); },
    error(name: string, data: Record<string, unknown>) { events.push({ level: "error", name, data }); },
  };
  const route = createMerchantBootstrapRoute({
    authenticator: authenticator as never,
    service: new MerchantBootstrapReadService(database as never),
    logger: logger as never,
    now: () => Date.parse("2026-10-16T12:00:00.000Z"),
  });
  return { route, calls, databaseQueries, events, get writes() { return writes; } };
}

async function withRoute(
  route: ReturnType<typeof createMerchantBootstrapRoute>,
  run: (origin: string) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void route.handle(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}');
      }
    }).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("bootstrap route keeps its public path, scoped read model, headers and no-write behaviour", async () => {
  assert.equal(MERCHANT_BOOTSTRAP_ROUTE_PATH, "/v1/merchant/bootstrap");
  const f = fixture();
  await withRoute(f.route, async (origin) => {
    const response = await fetch(`${origin}${MERCHANT_BOOTSTRAP_ROUTE_PATH}`, {
      headers: { ...authHeaders, "x-shop-id": "spoofed-shop", "x-customer-id": "private-customer" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await response.json(), {
      schemaVersion: 1,
      shop: {
        id: principal.shopId, platform: "WOOCOMMERCE", domain: principal.canonicalSiteUrl,
        onboardingCompleted: false, installedAt: "2026-10-02T10:00:00.000Z",
      },
      internationalContext: {
        storeLocale: "pt_BR", languageTag: "pt-BR", timeZone: "America/Sao_Paulo", countryCode: "BR",
      },
      storeProfile: {
        activeCategory: null, pendingCategory: null, pendingSelectionGeneration: 0, pendingSelectedAt: null,
      },
    });
  });
  assert.deepEqual(f.calls, ["authenticate", "read-shop"]);
  assert.deepEqual((f.databaseQueries[0] as { where: unknown }).where, { id: principal.shopId });
  assert.equal(f.writes, 0);
  assert.deepEqual(f.events, [{
    level: "info", name: "merchant.bootstrap.read",
    data: {
      installationId: principal.installationId, shopId: principal.shopId,
      outcome: "success", onboardingCompleted: false, durationMs: 0,
    },
  }]);
  assert.equal(JSON.stringify(f.events).includes("spoofed-shop"), false);
  assert.equal(JSON.stringify(f.events).includes("private-customer"), false);
  assert.equal(JSON.stringify(f.events).includes("private-credential"), false);
});

test("bootstrap rejects any query after authentication, without querying or writing", async () => {
  for (const suffix of ["?shopId=caller-controlled", "?locale=pt-BR"]) {
    const f = fixture();
    await withRoute(f.route, async (origin) => {
      const response = await fetch(`${origin}${MERCHANT_BOOTSTRAP_ROUTE_PATH}${suffix}`, { headers: authHeaders });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_request" });
      assert.equal(response.headers.get("cache-control"), "no-store");
    });
    assert.deepEqual(f.calls, ["authenticate"]);
    assert.deepEqual(f.events, []);
    assert.equal(f.writes, 0);
  }
});

test("bootstrap rejects missing or revoked authentication before query validation", async () => {
  for (const options of [{}, { authFailure: new WooUnauthenticatedError() }]) {
    const f = fixture(options);
    await withRoute(f.route, async (origin) => {
      const response = await fetch(`${origin}${MERCHANT_BOOTSTRAP_ROUTE_PATH}?shopId=other`);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    });
    assert.deepEqual(f.calls, ["authenticate"]);
    assert.deepEqual(f.events, []);
    assert.equal(f.writes, 0);
  }
});

test("bootstrap maps tenant-integrity rejection to a bounded 500 without leaking details", async () => {
  for (const options of [
    { shop: { ...shopRow, id: "another-shop" } },
    { readFailure: new MerchantBootstrapIntegrityError() },
  ]) {
    const f = fixture(options);
    await withRoute(f.route, async (origin) => {
      const response = await fetch(`${origin}${MERCHANT_BOOTSTRAP_ROUTE_PATH}`, { headers: authHeaders });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "internal_error" });
    });
    assert.deepEqual(f.calls, ["authenticate", "read-shop"]);
    assert.deepEqual(f.events, [{ level: "error", name: "merchant.bootstrap.read.failed", data: { reason: "integrity" } }]);
    assert.equal(f.writes, 0);
  }
});

test("bootstrap logs unexpected read failures as internal without exposing exception messages", async () => {
  const f = fixture({ readFailure: new Error("do not leak database connection string") });
  await withRoute(f.route, async (origin) => {
    const response = await fetch(`${origin}${MERCHANT_BOOTSTRAP_ROUTE_PATH}`, { headers: authHeaders });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
  });
  assert.deepEqual(f.events, [{ level: "error", name: "merchant.bootstrap.read.failed", data: { reason: "internal" } }]);
  assert.equal(JSON.stringify(f.events).includes("connection string"), false);
});

test("bootstrap leaves unrelated endpoints and wrong methods to the next router", async () => {
  const f = fixture();
  await withRoute(f.route, async (origin) => {
    for (const [method, path] of [
      ["POST", MERCHANT_BOOTSTRAP_ROUTE_PATH], ["DELETE", MERCHANT_BOOTSTRAP_ROUTE_PATH],
      ["GET", "/v1/merchant/store-context"], ["GET", "/v1/billing"],
    ] as const) {
      const response = await fetch(`${origin}${path}`, { method });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
  });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.events, []);
});
