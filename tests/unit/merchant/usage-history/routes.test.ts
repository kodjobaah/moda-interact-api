import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { createMerchantUsageHistoryRoute } from "../../../../src/merchant/usage-history/routes.js";
import { UsageHistoryRequestError, USAGE_HISTORY_PATH, type UsageHistoryQuery } from "../../../../src/merchant/usage-history/contract.js";

async function withServer(fn: (url: string, calls: unknown[], logs: unknown[]) => Promise<void>) {
  const calls: unknown[] = [], logs: unknown[] = [];
  const route = createMerchantUsageHistoryRoute({
    authenticator: { async authenticate(req: { headers: { authorization?: string } }) {
      if (req.headers.authorization !== "Bearer known") throw new WooUnauthenticatedError();
      return { installationId: "install_1", shopId: "shop_1", credentialVersion: 1, canonicalSiteUrl: "https://shop.test" };
    } } as never,
    service: { async read(_principal: unknown, query: UsageHistoryQuery) {
      calls.push(query);
      if (query.periodCursor) throw new UsageHistoryRequestError("invalid_cursor");
      if (query.periodId) throw new UsageHistoryRequestError("invalid_period");
      return { schemaVersion: 1, state: "ready", usageView: query.view,
        periodPage: { items: [], previousCursor: null, nextCursor: null }, usageEvents: [],
        usagePagination: { page: query.page, pageSize: query.pageSize, total: 0,
          totalQuantity: 0, billId: null, periodStart: null, periodEnd: null } };
    } } as never,
    logger: { info(event: string, data: unknown) { logs.push({ event, data }); },
      warn(event: string, data: unknown) { logs.push({ event, data }); },
      error(event: string, data: unknown) { logs.push({ event, data }); } } as never,
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
    for (const fragment of ["shopId=foreign", "page=999999", "kind=ALL&kind=ALL", "page=0", "pageSize=15"]) {
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
