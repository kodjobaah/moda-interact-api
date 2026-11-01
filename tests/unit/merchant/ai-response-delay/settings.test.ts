import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../../../src/auth/woo-installation/authenticator.js";
import {
  AiResponseDelayConflictError,
  AiResponseDelayRequestError,
  AiResponseDelayUnauthorizedError,
  MERCHANT_AI_RESPONSE_DELAY_PATH,
  parseAiResponseDelayWrite,
} from "../../../../src/merchant/ai-response-delay/contract.js";
import { createMerchantAiResponseDelayRoutes } from "../../../../src/merchant/ai-response-delay/routes.js";
import { MerchantAiResponseDelayService } from "../../../../src/merchant/ai-response-delay/service.js";

const principal = {
  installationId: "install-1", shopId: "shop-1", canonicalSiteUrl: "https://shop.example",
  credentialVersion: 1,
};
const timestamp = new Date("2026-10-31T16:28:55.123Z");
const shop = {
  id: "shop-1", domain: principal.canonicalSiteUrl, platform: "WOOCOMMERCE", shopifyShopId: null,
  status: "ACTIVE", onboardingCompleted: true,
};
const installation = {
  id: principal.installationId, shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
  credentialVersion: 1, status: "ACTIVE", revokedAt: null,
};

function write(expectedRevision: string, aiResponseDelayMinutes: number) {
  return parseAiResponseDelayWrite({ schemaVersion: 1, expectedRevision, aiResponseDelayMinutes });
}

function serviceFixture(options: { settings?: Record<string, unknown> | null; revoked?: boolean } = {}) {
  let settings = options.settings === undefined ? null : options.settings;
  let revoked = options.revoked ?? false;
  const writes: unknown[] = [];
  const locks: string[] = [];
  const tx = {
    async $queryRaw(query: { sql: string }) {
      locks.push(query.sql);
      if (query.sql.includes('FROM "commerce"."Shop"')) return [shop];
      return [revoked ? { ...installation, status: "REVOKED" } : installation];
    },
    shopSettings: {
      async findUnique() { return settings; },
      async update(args: { data: Record<string, unknown> }) {
        writes.push(args.data);
        settings = { ...settings, ...args.data };
        return settings;
      },
      async create(args: { data: Record<string, unknown> }) {
        writes.push(args.data);
        settings = { id: "settings-1", ...args.data };
        return settings;
      },
    },
  };
  const database = { async $transaction(callback: (transaction: typeof tx) => unknown) { return callback(tx); } };
  return {
    service: new MerchantAiResponseDelayService(database as never, () => timestamp),
    writes,
    locks,
    setRevoked(value: boolean) { revoked = value; },
    getSettings() { return settings; },
  };
}

test("shared write contract accepts 0, 7 and 30 and rejects malformed or extra fields", () => {
  for (const value of [0, 7, 30]) assert.equal(write("UNCONFIGURED", value).aiResponseDelayMinutes, value);
  for (const value of [-1, 31, 0.5, "7"]) {
    assert.throws(() => parseAiResponseDelayWrite({ schemaVersion: 1, expectedRevision: "UNCONFIGURED", aiResponseDelayMinutes: value }),
      (error: unknown) => error instanceof AiResponseDelayRequestError && error.status === 400);
  }
  assert.throws(() => parseAiResponseDelayWrite({ schemaVersion: 1, expectedRevision: "UNCONFIGURED", aiResponseDelayMinutes: 7, shopId: "other" }),
    AiResponseDelayRequestError);
});

test("reads and updates only the response delay, creates established defaults and keeps revisions monotonic", async () => {
  const fixture = serviceFixture();
  assert.deepEqual(await fixture.service.read(principal), {
    schemaVersion: 1, revision: "UNCONFIGURED", aiResponseDelayMinutes: 0,
  });
  const saved = await fixture.service.update(principal, write("UNCONFIGURED", 7));
  assert.deepEqual(saved, { schemaVersion: 1, revision: timestamp.toISOString(), aiResponseDelayMinutes: 7 });
  assert.equal(fixture.writes.length, 1);
  const created = fixture.writes[0] as Record<string, unknown>;
  assert.equal(created.shopId, principal.shopId);
  assert.equal(created.onboardingCompleted, true);
  assert.equal(created.recoveryDelayMinutes, 30);
  assert.equal(created.recoveryOfferMode, "NONE");
  assert.equal(created.followUpEnabled, false);
  assert.equal(created.aiResponseDelayMinutes, 7);

  const current = fixture.getSettings() as Record<string, unknown>;
  current.updatedAt = timestamp;
  current.recoveryDelayMinutes = 17;
  const changed = await fixture.service.update(principal, write(timestamp.toISOString(), 30));
  assert.ok(Date.parse(changed.revision) > timestamp.getTime());
  assert.deepEqual(fixture.writes[1], { aiResponseDelayMinutes: 30, updatedAt: new Date(Date.parse(changed.revision)) });
  assert.equal((fixture.getSettings() as Record<string, unknown>).recoveryDelayMinutes, 17);
});

test("current-revision same-value retries do not write; stale different values conflict", async () => {
  const fixture = serviceFixture({ settings: {
    id: "settings-1", shopId: principal.shopId, aiResponseDelayMinutes: 7, updatedAt: timestamp,
  } });
  const retry = await fixture.service.update(principal, write(timestamp.toISOString(), 7));
  assert.equal(retry.revision, timestamp.toISOString());
  assert.equal(fixture.writes.length, 0);
  await assert.rejects(fixture.service.update(principal, write("UNCONFIGURED", 30)), AiResponseDelayConflictError);
  assert.equal(fixture.writes.length, 0);
});

test("revoked installation is rechecked in the transaction before any update", async () => {
  const fixture = serviceFixture({ revoked: true, settings: {
    id: "settings-1", shopId: principal.shopId, aiResponseDelayMinutes: 0, updatedAt: timestamp,
  } });
  await assert.rejects(fixture.service.update(principal, write(timestamp.toISOString(), 7)), AiResponseDelayUnauthorizedError);
  assert.equal(fixture.writes.length, 0);
  assert.match(fixture.locks[0] ?? "", /FOR UPDATE/);
  assert.match(fixture.locks[1] ?? "", /FOR SHARE/);
});

async function withRoute(
  callback: (origin: string) => Promise<void>,
  auth: Partial<WooInstallationAuthenticator> = {},
  service: object = { async read() { return { schemaVersion: 1, revision: "UNCONFIGURED", aiResponseDelayMinutes: 0 }; }, async update() { return { schemaVersion: 1, revision: timestamp.toISOString(), aiResponseDelayMinutes: 7 }; } },
) {
  const route = createMerchantAiResponseDelayRoutes({
    authenticator: { async authenticate() { return principal; }, ...auth } as WooInstallationAuthenticator,
    service: service as MerchantAiResponseDelayService,
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  const server = createServer(async (request, response) => {
    if (!await route.handle(request, response)) { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("same-value PUT succeeds only with the current revision and never writes", async () => {
  const fixture = serviceFixture({ settings: {
    id: "settings-1", shopId: principal.shopId, aiResponseDelayMinutes: 7, updatedAt: timestamp,
  } });
  await withRoute(async (origin) => {
    const currentRevision = await fetch(`${origin}${MERCHANT_AI_RESPONSE_DELAY_PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, expectedRevision: timestamp.toISOString(), aiResponseDelayMinutes: 7 }),
    });
    assert.equal(currentRevision.status, 200);
    assert.deepEqual(await currentRevision.json(), {
      schemaVersion: 1, revision: timestamp.toISOString(), aiResponseDelayMinutes: 7,
    });
    assert.equal(fixture.writes.length, 0);

    const staleRevision = await fetch(`${origin}${MERCHANT_AI_RESPONSE_DELAY_PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, expectedRevision: "UNCONFIGURED", aiResponseDelayMinutes: 7 }),
    });
    assert.equal(staleRevision.status, 409);
    assert.deepEqual(await staleRevision.json(), { error: "ai_response_delay_conflict" });
    assert.equal(fixture.writes.length, 0);
  }, {}, fixture.service);
});

test("GET and PUT are authenticated, no-store, reject browser tenant overrides and malformed writes", async () => {
  await withRoute(async (origin) => {
    const read = await fetch(`${origin}${MERCHANT_AI_RESPONSE_DELAY_PATH}`);
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.deepEqual(await read.json(), { schemaVersion: 1, revision: "UNCONFIGURED", aiResponseDelayMinutes: 0 });

    for (const suffix of ["?shopId=shop-2", "?tenant=shop-2"]) {
      const response = await fetch(`${origin}${MERCHANT_AI_RESPONSE_DELAY_PATH}${suffix}`);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_request" });
    }
    const malformed = await fetch(`${origin}${MERCHANT_AI_RESPONSE_DELAY_PATH}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, expectedRevision: "UNCONFIGURED", aiResponseDelayMinutes: 7, shopId: "shop-2" }),
    });
    assert.equal(malformed.status, 400);
  });
  await withRoute(async (origin) => {
    const response = await fetch(`${origin}${MERCHANT_AI_RESPONSE_DELAY_PATH}`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }, { async authenticate(): Promise<never> { throw new WooUnauthenticatedError(); } });
});