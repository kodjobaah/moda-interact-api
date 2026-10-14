import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WooUnauthenticatedError } from "../../woocommerce/installation/authenticator.js";
import { RecoveryListIntegrityError } from "./contract.js";
import { InvalidRecoveryListQuery } from "./query.js";
import { MERCHANT_RECOVERIES_ROUTE_PATH, createMerchantRecoveriesRoute } from "./routes.js";

const principal = { installationId: "install", shopId: "shop", canonicalSiteUrl: "https://woo.example", credentialVersion: 1 };
const fixture = {
  schemaVersion: 1, timeZone: "UTC", from: "2026-09-12", to: "2026-10-11", q: "", status: "all",
  page: 1, pageSize: 25, total: 0, totalPages: 1, hasPrevious: false, hasNext: false, items: [],
};

function response() {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  const output = {
    destroyed: false, headersSent: false,
    writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  return { output, result: () => ({ status, headers, body: JSON.parse(body) as Record<string, unknown> }) };
}

function request(url = MERCHANT_RECOVERIES_ROUTE_PATH, rawHeaders: string[] = [], method = "GET") {
  return { method, url, rawHeaders } as unknown as IncomingMessage;
}

function makeRoute(options: { authError?: Error; serviceError?: Error; result?: unknown } = {}) {
  const calls: string[] = [];
  const instance = createMerchantRecoveriesRoute({
    authenticator: { authenticate: async () => {
      calls.push("authenticate");
      if (options.authError) throw options.authError;
      return principal;
    } } as never,
    service: { read: async (actualPrincipal: { shopId: string }, params: URLSearchParams) => {
      calls.push(`read:${actualPrincipal.shopId}:${params.toString()}`);
      if (options.serviceError) throw options.serviceError;
      return options.result ?? fixture;
    } } as never,
    logger: { info: () => { calls.push("logged-success"); }, warn: () => { calls.push("logged-integrity"); },
      error: () => { calls.push("logged-internal"); } } as never,
  });
  return { instance, calls };
}

test("reads a bounded, private paginated response with authenticated shop only", async () => {
  const { instance, calls } = makeRoute();
  const output = response();
  assert.equal(await instance.handle(request(`${MERCHANT_RECOVERIES_ROUTE_PATH}?page=2&pageSize=10`), output.output), true);
  assert.equal(output.result().status, 200);
  assert.deepEqual(output.result().body, fixture);
  assert.equal(output.result().headers["cache-control"], "private, no-store");
  assert.deepEqual(calls, ["authenticate", "read:shop:page=2&pageSize=10", "logged-success"]);
});

test("other routes and non-GET methods are not intercepted", async () => {
  const { instance, calls } = makeRoute();
  assert.equal(await instance.handle(request("/v1/merchant/other"), response().output), false);
  assert.equal(await instance.handle(request(MERCHANT_RECOVERIES_ROUTE_PATH, [], "POST"), response().output), false);
  assert.deepEqual(calls, []);
});

test("invalid credentials are rejected before the read service", async () => {
  const { instance, calls } = makeRoute({ authError: new WooUnauthenticatedError() });
  const output = response();
  await instance.handle(request(), output.output);
  assert.deepEqual(output.result().body, { error: "unauthorized" });
  assert.equal(output.result().status, 401);
  assert.deepEqual(calls, ["authenticate"]);
});

test("body/overlong URL requests and invalid filters fail without exposing data", async () => {
  for (const headers of [["Content-Length", "1"], ["Transfer-Encoding", "chunked"]]) {
    const { instance, calls } = makeRoute();
    const output = response();
    await instance.handle(request(MERCHANT_RECOVERIES_ROUTE_PATH, headers), output.output);
    assert.deepEqual(output.result().body, { error: "invalid_request" });
    assert.equal(output.result().status, 400);
    assert.deepEqual(calls, ["authenticate"]);
  }
  const bad = makeRoute();
  const output = response();
  await bad.instance.handle(request(`${MERCHANT_RECOVERIES_ROUTE_PATH}?q=${"x".repeat(2100)}`), output.output);
  assert.equal(output.result().status, 400);
  assert.equal(bad.calls.length, 1);
});

test("rejects bad query, integrity mismatch and server failure using distinct safe codes", async () => {
  for (const [failure, status, code] of [
    [new InvalidRecoveryListQuery(), 400, "invalid_request"],
    [new RecoveryListIntegrityError(), 409, "recovery_list_integrity_invalid"],
    [new Error("postgres://user:secret@host"), 500, "internal_error"],
  ] as const) {
    const { instance } = makeRoute({ serviceError: failure });
    const output = response();
    await instance.handle(request(), output.output);
    assert.equal(output.result().status, status);
    assert.deepEqual(output.result().body, { error: code });
    assert.doesNotMatch(JSON.stringify(output.result()), /secret@host/);
  }
});

test("rejects a malformed outgoing response instead of leaking arbitrary fields", async () => {
  const { instance } = makeRoute({ result: { ...fixture, secret: "private checkout" } });
  const output = response();
  await instance.handle(request(), output.output);
  assert.deepEqual(output.result().body, { error: "recovery_list_integrity_invalid" });
  assert.equal(output.result().status, 409);
});
