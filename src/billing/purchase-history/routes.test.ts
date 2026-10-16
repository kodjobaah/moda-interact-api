import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { createWooPurchaseHistoryRoute, WOO_PURCHASE_HISTORY_ROUTE_PATH } from "./routes.js";

async function withEndpoint(fn: (origin: string, calls: unknown[]) => Promise<void>): Promise<void> {
  const calls: unknown[] = [];
  const logger = createLogger({ serviceName: "history-route-test", environment: "test", sink: () => undefined });
  const handler = createWooPurchaseHistoryRoute({
    authenticator: {
      authenticate: async (req: IncomingMessage) => {
        if (req.headers.authorization !== "Bearer test-credential") throw new WooUnauthenticatedError();
        return { installationId: "installation", shopId: "shop-1", canonicalSiteUrl: "https://merchant.example/", credentialVersion: 1 };
      },
    } as never,
    service: {
      read: async (_principal: unknown, query: unknown) => {
        calls.push(query);
        return { schemaVersion: 1, ...query as object, page: 1, total: 0, totalPages: 1, purchases: [],
          refundRequest: { method: "WOOCOMMERCE_ORDERS", url: "https://woocommerce.com/my-account/orders/" } };
      },
    } as never,
    logger,
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handler.handle(req, res).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await fn(`http://127.0.0.1:${address.port}`, calls); }
  finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
}

test("GET-only history: authentication, strict filters, pagination and external Orders navigation", async () => {
  await withEndpoint(async (origin, calls) => {
    const url = `${origin}${WOO_PURCHASE_HISTORY_ROUTE_PATH}`;
    const denied = await fetch(url);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "unauthorized" });
    assert.equal(calls.length, 0);

    const headers = { authorization: "Bearer test-credential" };
    const ok = await fetch(`${url}?filter=REFUNDED&page=2&pageSize=10`, { headers });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("cache-control") ?? "", /no-store/);
    assert.equal((await ok.json() as { refundRequest: { url: string } }).refundRequest.url,
      "https://woocommerce.com/my-account/orders/");
    assert.deepEqual(calls, [{ filter: "REFUNDED", page: 2, pageSize: 10 }]);

    for (const query of ["?filter=ACTIVE&filter=ALL", "?filter=BOGUS", "?page=0", "?pageSize=25", "?shopId=other"]) {
      const bad = await fetch(`${url}${query}`, { headers });
      assert.equal(bad.status, 400, query);
      assert.deepEqual(await bad.json(), { error: "invalid_request" });
    }
    assert.equal(calls.length, 1);
    const write = await fetch(url, { headers, method: "POST" });
    assert.equal(write.status, 404);
    assert.equal(calls.length, 1);
  });
});
