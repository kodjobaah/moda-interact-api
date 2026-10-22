import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { createMerchantUsageHistoryRoute } from "../../../../src/merchant/usage-history/routes.js";
import { UsageHistoryIntegrityError, UsageHistoryRequestError, USAGE_HISTORY_PATH, type UsageHistoryQuery } from "../../../../src/merchant/usage-history/contract.js";

interface RecordedLog {
  level: "info" | "warn" | "error";
  event: string;
  data: Record<string, unknown>;
}
interface ServerOptions {
  serviceError?: Error;
  unattributed?: boolean;
}
async function withServer(
  fn: (url: string, calls: unknown[], logs: RecordedLog[]) => Promise<void>,
  options: ServerOptions = {},
) {
  const calls: unknown[] = [], logs: RecordedLog[] = [];
  const route = createMerchantUsageHistoryRoute({
    authenticator: { async authenticate(req: { headers: { authorization?: string } }) {
      if (req.headers.authorization !== "Bearer known") throw new WooUnauthenticatedError();
      return { installationId: "install_1", shopId: "shop_1", credentialVersion: 1, canonicalSiteUrl: "https://shop.test" };
    } } as never,
    service: { async read(_principal: unknown, query: UsageHistoryQuery) {
      calls.push(query);
      if (options.serviceError) throw options.serviceError;
      if (query.periodCursor) throw new UsageHistoryRequestError("invalid_cursor");
      if (query.periodId) throw new UsageHistoryRequestError("invalid_period");
      const unattributed = query.responseVersion === 2 && options.unattributed;
      return { schemaVersion: query.responseVersion === 2 ? 2 : 1, state: "ready", usageView: query.view,
        periodPage: { items: [], previousCursor: null, nextCursor: null },
        usageEvents: unattributed ? [{ id: "usage_unattributed", metric: "RECOVERY_CONVERSATION", quantity: 1,
          occurredAt: "2026-10-22T10:00:00.000Z", sourceRecovery: null, chargedAgainst: "UNATTRIBUTED" }] : [],
        usagePagination: { page: query.page, pageSize: query.pageSize, total: unattributed ? 1 : 0,
          totalQuantity: unattributed ? 1 : 0, billId: null, periodStart: null, periodEnd: null } };
    } } as never,
    logger: { info(event: string, data: Record<string, unknown>) { logs.push({ level: "info", event, data }); },
      warn(event: string, data: Record<string, unknown>) { logs.push({ level: "warn", event, data }); },
      error(event: string, data: Record<string, unknown>) { logs.push({ level: "error", event, data }); } } as never,
  });
  const server = createServer((request, response) => {
    void route.handle(request, response).then((handled) => {
      if (!handled) { response.statusCode = 404; response.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await fn(`http://127.0.0.1:${address.port}${USAGE_HISTORY_PATH}`, calls, logs); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("GET only; authentication before query, no-store, bounded filters and privacy-safe errors", async () => {
  await withServer(async (url, calls, logs) => {
    const denied = await fetch(url);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "unauthorized" });
    assert.equal(calls.length, 0);
    const headers = { authorization: "Bearer known" };
    const ok = await fetch(`${url}?view=past&kind=RECOVERY_CONVERSATION&page=3&pageSize=50`, { headers });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual((await ok.json() as { usageEvents: unknown[] }).usageEvents, []);
    assert.deepEqual(calls, [{ view: "past", kind: "RECOVERY_CONVERSATION", page: 3,
      pageSize: 50, periodId: null, periodCursor: null }]);
    const optedIn = await fetch(`${url}?responseVersion=2`, { headers });
    assert.equal(optedIn.status, 200);
    assert.equal((await optedIn.json() as { schemaVersion: number }).schemaVersion, 2);
    assert.deepEqual(calls.at(-1), { view: "current", kind: "ALL", page: 1, pageSize: 10,
      periodId: null, periodCursor: null, responseVersion: 2 });
    for (const fragment of ["responseVersion=3", "responseVersion=02", "responseVersion=2&responseVersion=2", "shopId=foreign", "page=999999", "kind=ALL&kind=ALL", "page=0", "pageSize=15"]) {
      const invalid = await fetch(`${url}?${fragment}`, { headers });
      assert.equal(invalid.status, 400, fragment);
      assert.deepEqual(await invalid.json(), { error: "invalid_request" });
    }
    const cursor = await fetch(`${url}?periodCursor=bad`, { headers });
    assert.equal(cursor.status, 409);
    assert.deepEqual(await cursor.json(), { error: "invalid_cursor" });
    const foreign = await fetch(`${url}?view=past&periodId=foreign`, { headers });
    assert.equal(foreign.status, 409);
    assert.deepEqual(await foreign.json(), { error: "invalid_period" });
    assert.equal((await fetch(url, { method: "POST", headers })).status, 404);
    assert.equal(JSON.stringify(logs).includes("foreign"), false);
    assert.equal(JSON.stringify(logs).includes("bad"), false);
  });
});


test("usage history logs authentication and request failures without credentials or raw query values", async () => {
  await withServer(async (url, _calls, logs) => {
    const unauthorized = await fetch(url, { headers: { authorization: "Bearer secret-value" } });
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(`${url}?periodId=sensitive-metadata`, {
      headers: { authorization: "Bearer known" },
    });
    assert.equal(invalid.status, 409);
    const denied = logs.filter((log) => log.event === "merchant.usage_history.denied");
    assert.deepEqual(denied.map((log) => log.data.reason), ["unauthorized", "invalid_period"]);
    assert.ok(denied.every((log) => log.level === "warn"));
    assert.equal(denied[0]?.data.shopId, undefined);
    assert.equal(denied[1]?.data.shopId, "shop_1");
    assert.equal(JSON.stringify(logs).includes("secret-value"), false);
    assert.equal(JSON.stringify(logs).includes("sensitive-metadata"), false);
  });
});

test("integrity and unexpected database errors are sent to shared logger with Error object", async () => {
  for (const [failure, status, reason] of [
    [new UsageHistoryIntegrityError(), 409, "integrity"],
    [new Error("db-read-failed"), 500, "internal"],
  ] as const) {
    await withServer(async (url, _calls, logs) => {
      const response = await fetch(`${url}?responseVersion=2`, {
        headers: { authorization: "Bearer known" },
      });
      assert.equal(response.status, status);
      const responseText = await response.text();
      assert.equal((JSON.parse(responseText) as { error: string }).error,
        status === 409 ? "usage_history_integrity_invalid" : "internal_error");
      assert.equal(responseText.includes("db-read-failed"), false);
      const record = logs.find((entry) => entry.event === "merchant.usage_history.failed");
      assert.ok(record);
      assert.equal(record.level, "error");
      assert.equal(record.data.reason, reason);
      assert.equal(record.data.shopId, "shop_1");
      assert.equal(record.data.error, failure);
      assert.ok(typeof record.data.durationMs === "number");
    }, { serviceError: failure });
  }
});

test("v2 unattributed evidence is visible and emits a bounded shared-logger warning", async () => {
  await withServer(async (url, _calls, logs) => {
    const response = await fetch(`${url}?responseVersion=2`, {
      headers: { authorization: "Bearer known" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { usageEvents: Array<{ chargedAgainst: string }> };
    assert.equal(body.usageEvents[0]?.chargedAgainst, "UNATTRIBUTED");
    const attributionLog = logs.find((record) => record.event === "merchant.usage_history.attribution.unattributed");
    assert.ok(attributionLog);
    assert.equal(attributionLog.level, "warn");
    assert.equal(attributionLog.data.shopId, "shop_1");
    assert.equal(attributionLog.data.count, 1);
    assert.deepEqual(attributionLog.data.eventIds, ["usage_unattributed"]);
    assert.equal(logs.some((entry) => entry.event === "merchant.usage_history.failed"), false);
  }, { unattributed: true });
});
