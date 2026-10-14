import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WooUnauthenticatedError } from "../../../woocommerce/installation/authenticator.js";
import { createMerchantRecoveryDetailRoute } from "./routes.js";

const principal = { installationId: "install", shopId: "shop", canonicalSiteUrl: "https://woo.example", credentialVersion: 1 };
const summary = {
  schemaVersion: 1, id: "rec_1", timeZone: "UTC", status: "COMPLETED",
  value: { amount: "89.99", currency: "GBP", incomplete: false },
  customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
  hasConversation: true,
  milestones: { detectedAt: "2026-10-09T15:44:00.000Z", messageSentAt: null,
    engagedAt: null, completedAt: null, expiredAt: null },
};
const emptyPage = { schemaVersion: 1, items: [], previousCursor: null, nextCursor: null };

function request(path: string, headers: string[] = [], method = "GET") {
  return { url: path, method, rawHeaders: headers } as unknown as IncomingMessage;
}
function response() {
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};
  const output = {
    destroyed: false, headersSent: false,
    writeHead(code: number, values: Record<string, string>) {
      status = code;
      Object.assign(headers, values);
    },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  return { output, result: () => ({ status, headers, body: JSON.parse(body) as Record<string, unknown> }) };
}
function setup({ authError, serviceError, result }: { authError?: Error; serviceError?: Error; result?: unknown } = {}) {
  const calls: string[] = [];
  const instance = createMerchantRecoveryDetailRoute({
    authenticator: { authenticate: async () => {
      calls.push("auth");
      if (authError) throw authError;
      return principal;
    } } as never,
    service: {
      summary: async () => { calls.push("summary"); if (serviceError) throw serviceError; return result === undefined ? summary : result; },
      messages: async () => { calls.push("messages"); if (serviceError) throw serviceError; return result === undefined ? emptyPage : result; },
      related: async () => { calls.push("related"); if (serviceError) throw serviceError; return result === undefined ? emptyPage : result; },
    } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
  });
  return { instance, calls };
}

test("three authenticated read paths return private, bounded JSON", async () => {
  for (const [path, expected] of [
    ["/v1/merchant/recoveries/rec_1", "summary"],
    ["/v1/merchant/recoveries/rec_1/messages?window=latest", "messages"],
    ["/v1/merchant/recoveries/rec_1/related", "related"],
  ] as const) {
    const { instance, calls } = setup();
    const output = response();
    assert.equal(await instance.handle(request(path), output.output), true);
    assert.equal(output.result().status, 200);
    assert.equal(output.result().headers["cache-control"], "private, no-store");
    assert.deepEqual(calls, ["auth", expected]);
  }
});

test("authentication occurs before request validation; foreign/missing ID cannot leak existence", async () => {
  const unauth = setup({ authError: new WooUnauthenticatedError() });
  const first = response();
  await unauth.instance.handle(request("/v1/merchant/recoveries/rec_1"), first.output);
  assert.equal(first.result().status, 401);
  const absent = setup({ result: null });
  const second = response();
  await absent.instance.handle(request("/v1/merchant/recoveries/rec_1"), second.output);
  assert.equal(second.result().status, 404);
  assert.deepEqual(second.result().body, { error: "not_found" });
});

test("bad paths, bodies, query and unsafe response fail without returning secret content", async () => {
  const instance = setup().instance;
  assert.equal(await instance.handle(request("/v1/merchant/recoveries", [], "GET"), response().output), false);
  assert.equal(await instance.handle(request("/v1/merchant/recoveries/rec_1", [], "POST"), response().output), false);
  for (const path of ["/v1/merchant/recoveries/rec_1?cursor=abc", "/v1/merchant/recoveries/a%2Fb",
    "/v1/merchant/recoveries/rec_1/related?window=latest"]) {
    const output = response();
    await instance.handle(request(path), output.output);
    assert.equal(output.result().status, 400);
  }
  const body = response();
  await instance.handle(request("/v1/merchant/recoveries/rec_1", ["Content-Length", "1"]), body.output);
  assert.equal(body.result().status, 400);
  const secret = response();
  await setup({ result: { ...summary, bearer: "super-secret" } }).instance.handle(
    request("/v1/merchant/recoveries/rec_1"), secret.output);
  assert.equal(secret.result().status, 409);
  assert.doesNotMatch(JSON.stringify(secret.result()), /super-secret/);
});
