import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WooUnauthenticatedError } from "../../woocommerce/installation/authenticator.js";
import { createMerchantRecoverySummaryRoute } from "./routes.js";

const principal = {
  installationId: "install_1", shopId: "shop_1", credentialVersion: 1,
  canonicalSiteUrl: "https://woo.example",
};
const summary = {
  schemaVersion: 1, recoveryDelayMinutes: 30, recoveryOfferMode: "NONE",
  followUpEnabled: false, followUpDelayMinutes: null, source: "MERCHANT",
};

function response() {
  let status = 0;
  let body = "";
  const object = {
    destroyed: false, headersSent: false,
    writeHead(code: number) { status = code; },
    end(value: string) { body = value; },
  };
  return { object: object as unknown as ServerResponse, get: () => ({ status, body: JSON.parse(body) as Record<string, unknown> }) };
}

function route(options: { failAuth?: boolean; failService?: boolean } = {}) {
  let reads = 0;
  const instance = createMerchantRecoverySummaryRoute({
    authenticator: { authenticate: async () => {
      if (options.failAuth) throw new WooUnauthenticatedError();
      return principal;
    } } as never,
    service: { read: async () => {
      reads += 1;
      if (options.failService) throw new Error("private SQL details");
      return summary;
    } } as never,
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  return { instance, reads: () => reads };
}

function request(path: string): IncomingMessage {
  return { method: "GET", url: path, rawHeaders: [] } as unknown as IncomingMessage;
}

test("reads effective policy for the authenticated installation", async () => {
  const { instance } = route();
  const result = response();
  assert.equal(await instance.handle(request("/v1/merchant/recovery-summary"), result.object), true);
  assert.equal(result.get().status, 200);
  assert.deepEqual(result.get().body, summary);
});

test("rejects query-based tenant identifiers, no database read", async () => {
  const r = route();
  const result = response();
  await r.instance.handle(request("/v1/merchant/recovery-summary?shopId=other"), result.object);
  assert.equal(result.get().status, 400);
  assert.equal(r.reads(), 0);
});

test("rejects a missing or invalid credential", async () => {
  const r = route({ failAuth: true });
  const result = response();
  await r.instance.handle(request("/v1/merchant/recovery-summary"), result.object);
  assert.equal(result.get().status, 401);
});

test("fails closed without leaking database errors", async () => {
  const r = route({ failService: true });
  const result = response();
  await r.instance.handle(request("/v1/merchant/recovery-summary"), result.object);
  assert.equal(result.get().status, 500);
  assert.deepEqual(result.get().body, { error: "internal_error" });
});
