import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { createMerchantFeaturePreferencesRoute } from "../../../../src/merchant/feature-preferences/routes.js";
import { FeaturePreferencesConflictError, MERCHANT_FEATURE_PREFERENCES_PATH } from "../../../../src/merchant/feature-preferences/contract.js";

const revision = "a".repeat(64);
const principal = { shopId: "woo-shop", canonicalSiteUrl: "https://shop.invalid", installationId: "woo-i", credentialVersion: 1 };
const readResult = { schemaVersion: 1, revision, features: [{ id: "feature", key: "feature_key", name: "Feature", description: null,
  enabled: false, effective: false, editable: true, required: false, planEligible: true }] };
const update = { expectedRevision: revision, changes: [{ featureId: "feature", enabled: true }] };
function request(method: "GET" | "PUT", input: unknown = update, options: { url?: string; rawHeaders?: string[] } = {}): IncomingMessage {
  const body = method === "PUT" ? Buffer.from(JSON.stringify(input)) : Buffer.alloc(0);
  return Object.assign(Readable.from(body.length ? [body] : []), { method, url: options.url ?? MERCHANT_FEATURE_PREFERENCES_PATH,
    rawHeaders: options.rawHeaders ?? (method === "PUT" ? ["Content-Type", "application/json"] : []) }) as IncomingMessage;
}
function response() {
  let status = 0; let body = ""; let headers: Record<string, string> = {};
  const output = { destroyed: false, headersSent: false,
    writeHead(code: number, header: Record<string, string>) { status = code; headers = header; },
    end(data: string) { body = data; },
  } as unknown as ServerResponse;
  return { output, result: () => ({ status, headers, body: JSON.parse(body) as Record<string, unknown> }) };
}
function factory(options: { failAuth?: boolean; fail?: Error; corrupt?: boolean } = {}) {
  const calls: string[] = [];
  return { calls, route: createMerchantFeaturePreferencesRoute({
    authenticator: { authenticate: async () => { calls.push("authenticate"); if (options.failAuth) throw new WooUnauthenticatedError(); return principal; } } as never,
    service: {
      read: async () => { calls.push("read"); if (options.fail) throw options.fail;
        return options.corrupt ? { ...readResult, privateKey: "not-for-browser" } : readResult; },
      update: async (p: unknown, body: unknown) => { calls.push("update"); assert.deepEqual(p, principal);
        assert.deepEqual(body, update); if (options.fail) throw options.fail; return readResult; },
    } as never, logger: { info() {}, warn() {}, error() {} } as never,
  }) };
}
test("GET and PUT are authenticated, return no-store and exact DTO", async () => {
  const t = factory(); const r = response();
  assert.equal(await t.route.handle(request("GET"), r.output), true);
  assert.deepEqual(r.result().body, readResult);
  assert.equal(r.result().headers["cache-control"], "no-store");
  const put = response(); await t.route.handle(request("PUT"), put.output);
  assert.equal(put.result().status, 200);
  assert.deepEqual(t.calls, ["authenticate", "read", "authenticate", "update"]);
});
test("no authentication means no service or body access", async () => {
  const t = factory({ failAuth: true }); const r = response();
  await t.route.handle(request("PUT"), r.output);
  assert.equal(r.result().status, 401); assert.deepEqual(t.calls, ["authenticate"]);
});
test("query/body spoofing, duplicate headers, oversized and malformed inputs are denied", async () => {
  const cases: Array<[IncomingMessage, number]> = [
    [request("GET", update, { url: `${MERCHANT_FEATURE_PREFERENCES_PATH}?shopId=other` }), 400],
    [request("GET", update, { rawHeaders: ["Content-Length", "2"] }), 400],
    [request("PUT", { ...update, shopId: "other" }), 400],
    [request("PUT", update, { rawHeaders: ["Content-Type", "application/json", "content-type", "text/plain"] }), 400],
    [request("PUT", update, { rawHeaders: ["Content-Type", "application/json", "Content-Encoding", "gzip"] }), 400],
    [request("PUT", { ...update, filler: "x".repeat(66000) }), 413],
  ];
  for (const [req, status] of cases) {
    const t = factory(); const r = response();
    await t.route.handle(req, r.output);
    assert.equal(r.result().status, status); assert.deepEqual(t.calls, ["authenticate"]);
  }
});
test("conflict and malformed responses cannot leak secrets", async () => {
  for (const [options, code, status] of [
    [{ fail: new FeaturePreferencesConflictError("feature_preferences_conflict") }, "feature_preferences_conflict", 409],
    [{ corrupt: true }, "feature_preferences_integrity_invalid", 409],
    [{ fail: new Error("postgres://secret") }, "internal_error", 500],
  ] as const) {
    const t = factory(options); const r = response(); await t.route.handle(request("GET"), r.output);
    assert.equal(r.result().status, status); assert.deepEqual(r.result().body, { error: code });
  }
});
test("unknown methods or paths fall through without authentication", async () => {
  const t = factory(); const r = response();
  assert.equal(await t.route.handle(request("GET", update, { url: "/other" }), r.output), false);
  assert.equal(await t.route.handle(Object.assign(request("GET"), { method: "PATCH" }), r.output), false);
  assert.deepEqual(t.calls, []);
});
