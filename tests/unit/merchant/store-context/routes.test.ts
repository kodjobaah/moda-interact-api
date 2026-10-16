import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { PassThrough } from "node:stream";
import { WooUnauthenticatedError } from "../../../../src/woocommerce/installation/authenticator.js";
import { MAX_STORE_CONTEXT_BODY_BYTES, MERCHANT_STORE_CONTEXT_ROUTE_PATH, createMerchantStoreContextRoute } from "../../../../src/merchant/store-context/routes.js";
import { MerchantStoreContextConflictError } from "../../../../src/merchant/store-context/store-context.service.js";
import type { MerchantStoreContextSnapshot } from "../../../../src/merchant/store-context/schema.js";

const principal = {
  installationId: "verified_installation",
  shopId: "verified_shop",
  canonicalSiteUrl: "https://merchant.example",
  credentialVersion: 3,
};
const headers = {
  "x-moda-installation-id": principal.installationId,
  authorization: "Bearer private-credential",
  "content-type": "application/json",
};
const snapshot: MerchantStoreContextSnapshot = {
  schemaVersion: 1,
  storeLocale: "en_GB",
  languageTag: "en-GB",
  timeZone: "Europe/London",
  countryCode: "GB",
};
type LogEntry = { level: "info" | "warn" | "error"; event: string; data: Record<string, unknown> };

function fixture(options: { authFailure?: Error; updateFailure?: Error } = {}) {
  const calls: string[] = [];
  const writes: Array<{ principal: typeof principal; snapshot: MerchantStoreContextSnapshot }> = [];
  const logs: LogEntry[] = [];
  const route = createMerchantStoreContextRoute({
    authenticator: {
      authenticate: async (request: IncomingMessage) => {
        calls.push("authenticate");
        if (options.authFailure) throw options.authFailure;
        if (request.headers.authorization !== headers.authorization ||
          request.headers["x-moda-installation-id"] !== principal.installationId) throw new WooUnauthenticatedError();
        return principal;
      },
    } as never,
    service: {
      update: async (identity: typeof principal, value: MerchantStoreContextSnapshot) => {
        calls.push("update");
        writes.push({ principal: identity, snapshot: value });
        if (options.updateFailure) throw options.updateFailure;
      },
    } as never,
    logger: {
      info: (event: string, data: Record<string, unknown>) => logs.push({ level: "info", event, data }),
      warn: (event: string, data: Record<string, unknown>) => logs.push({ level: "warn", event, data }),
      error: (event: string, data: Record<string, unknown>) => logs.push({ level: "error", event, data }),
    } as never,
    now: () => 1000,
  });
  return { route, calls, writes, logs };
}

async function withRoute(
  route: ReturnType<typeof createMerchantStoreContextRoute>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void route.handle(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}');
      }
    }).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
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

function put(origin: string, body: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}${MERCHANT_STORE_CONTEXT_ROUTE_PATH}`, {
    method: "PUT", headers: { ...headers, ...extraHeaders }, body,
  });
}

/** A stream fixture exercises the same IncomingMessage events without the HTTP parser sanitising headers. */
async function streamRequest(
  f: ReturnType<typeof fixture>,
  options: {
    rawHeaders?: string[];
    body?: Buffer | string;
    event?: "aborted" | "error";
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const stream = new PassThrough() as PassThrough & IncomingMessage;
  stream.method = "PUT";
  stream.url = MERCHANT_STORE_CONTEXT_ROUTE_PATH;
  stream.headers = { authorization: headers.authorization, "x-moda-installation-id": headers["x-moda-installation-id"] };
  stream.rawHeaders = options.rawHeaders ?? ["content-type", "application/json", "content-encoding", "identity"];
  let status = 0;
  let responseHeaders: Record<string, string> = {};
  let body = "";
  const response = {
    destroyed: false,
    headersSent: false,
    writeHead(this: { headersSent: boolean }, statusCode: number, values: Record<string, string>) {
      status = statusCode;
      responseHeaders = values;
      this.headersSent = true;
      return this;
    },
    end(value?: string) { body = value ?? ""; return this; },
  } as unknown as ServerResponse;
  const processing = f.route.handle(stream, response);
  // Yield until authentication completes and the parser subscribes to stream events.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (options.event === "aborted") stream.emit("aborted");
  else if (options.event === "error") stream.emit("error", new Error("sensitive-stream-error"));
  else stream.end(options.body ?? JSON.stringify(snapshot));
  assert.equal(await processing, true);
  return { status, headers: responseHeaders, body };
}

test("store-context PUT keeps the scoped principal, exact 204 headers, no body and success log", async () => {
  const f = fixture();
  assert.equal(MERCHANT_STORE_CONTEXT_ROUTE_PATH, "/v1/merchant/store-context");
  assert.equal(MAX_STORE_CONTEXT_BODY_BYTES, 2048);
  await withRoute(f.route, async (origin) => {
    const response = await put(origin, JSON.stringify(snapshot), { "x-shop-id": "spoofed" });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-type"), null);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
  assert.deepEqual(f.calls, ["authenticate", "update"]);
  assert.deepEqual(f.writes, [{ principal, snapshot }]);
  assert.deepEqual(f.logs, [{
    level: "info", event: "merchant.store_context.sync", data: {
      installationId: principal.installationId, shopId: principal.shopId, outcome: "success", durationMs: 0,
    },
  }]);
  assert.equal(JSON.stringify(f.logs).includes("spoofed"), false);
  assert.equal(JSON.stringify(f.logs).includes(headers.authorization), false);
});

test("strict snapshot, JSON and query validation reject without writing", async () => {
  const f = fixture();
  await withRoute(f.route, async (origin) => {
    for (const body of ["not-json", "[]", "{}", JSON.stringify({ ...snapshot, shopId: "other" }),
      JSON.stringify({ ...snapshot, timeZone: "+01:00" }), JSON.stringify({ ...snapshot, countryCode: "gb" }),
      JSON.stringify({ ...snapshot, schemaVersion: 2 }), ` ${JSON.stringify(snapshot)}\u0000`]) {
      const response = await put(origin, body);
      assert.equal(response.status, 400, body);
      assert.deepEqual(await response.json(), { error: "invalid_request" });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }
    const query = await fetch(`${origin}${MERCHANT_STORE_CONTEXT_ROUTE_PATH}?shopId=other`, {
      method: "PUT", headers, body: JSON.stringify(snapshot),
    });
    assert.equal(query.status, 400);
    assert.deepEqual(await query.json(), { error: "invalid_request" });
  });
  assert.deepEqual(f.writes, []);
  assert.equal(f.logs.every((entry) => entry.event === "merchant.store_context.sync.failed" && entry.data.reason === "invalid_request"), true);
});

test("strict duplicate headers, media type, length and bounded streaming body are preserved", async () => {
  const f = fixture();
  for (const rawHeaders of [
    ["content-type", "application/json", "content-type", "application/json"],
    ["content-type", "text/plain"],
    ["content-type", "application/json", "content-encoding", "gzip"],
    ["content-type", "application/json", "content-encoding", "identity", "content-encoding", "identity"],
    ["content-type", "application/json", "content-length", "999999"],
    ["content-type", "application/json", "content-length", "1", "content-length", "1"],
    ["content-type", "application/json", "content-length", "-1"],
  ]) {
    const result = await streamRequest(f, { rawHeaders });
    assert.equal(result.status, rawHeaders.includes("999999") ? 413 : 400);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["x-content-type-options"], "nosniff");
  }
  const oversized = await streamRequest(f, { body: "x".repeat(MAX_STORE_CONTEXT_BODY_BYTES + 1) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(JSON.parse(oversized.body), { error: "request_too_large" });
  const invalidUtf8 = await streamRequest(f, { body: Buffer.from([0xc3, 0x28]) });
  assert.equal(invalidUtf8.status, 400);
  const valid = await streamRequest(f, { rawHeaders: ["content-type", "application/json; charset=utf-8"], body: JSON.stringify(snapshot) });
  assert.equal(valid.status, 204);
  assert.equal(f.writes.length, 1);
});

test("aborted and errored request streams return bounded 400 errors and never write", async () => {
  for (const event of ["aborted", "error"] as const) {
    const f = fixture();
    const result = await streamRequest(f, { event });
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.body), { error: "invalid_request" });
    assert.deepEqual(f.writes, []);
    assert.equal(f.logs[0]?.data.reason, "invalid_request");
    assert.equal(JSON.stringify(f.logs).includes("sensitive-stream-error"), false);
  }
});

test("authentication is checked before the query/body and errors do not leak tenant context", async () => {
  const f = fixture({ authFailure: new WooUnauthenticatedError() });
  await withRoute(f.route, async (origin) => {
    const response = await fetch(`${origin}${MERCHANT_STORE_CONTEXT_ROUTE_PATH}?shopId=spoofed`, {
      method: "PUT", headers, body: "bad-json",
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  });
  assert.deepEqual(f.calls, ["authenticate"]);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.logs, [{ level: "warn", event: "merchant.store_context.sync.failed", data: { reason: "unauthorized", durationMs: 0 } }]);
});

test("tenant conflict and internal failures retain distinct codes and bounded logs", async () => {
  for (const [error, status, code, level, reason] of [
    [new MerchantStoreContextConflictError(), 409, "store_context_conflict", "warn", "tenant_conflict"],
    [new Error("sensitive-connection-string"), 500, "internal_error", "error", "internal"],
  ] as const) {
    const f = fixture({ updateFailure: error });
    await withRoute(f.route, async (origin) => {
      const response = await put(origin, JSON.stringify(snapshot));
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
      assert.equal(response.headers.get("cache-control"), "no-store");
    });
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.logs, [{
      level, event: "merchant.store_context.sync.failed", data: {
        installationId: principal.installationId, shopId: principal.shopId, reason, durationMs: 0,
      },
    }]);
    assert.equal(JSON.stringify(f.logs).includes("sensitive-connection-string"), false);
  }
});

test("wrong methods and unrelated routes fall through without authenticating or writing", async () => {
  const f = fixture();
  await withRoute(f.route, async (origin) => {
    for (const [method, path] of [
      ["GET", MERCHANT_STORE_CONTEXT_ROUTE_PATH],
      ["POST", MERCHANT_STORE_CONTEXT_ROUTE_PATH],
      ["PUT", "/v1/merchant/bootstrap"],
      ["GET", "/v1/billing"],
    ] as const) {
      const response = await fetch(`${origin}${path}`, { method });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
  });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.logs, []);
});
