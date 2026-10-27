import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WooUnauthenticatedError } from "../../../../../src/auth/woo-installation/authenticator.js";
import { SendHttpError } from "../../../../../src/merchant/conversations/messages/contract.js";
import { createMerchantConversationMessageRoutes } from "../../../../../src/merchant/conversations/messages/routes.js";

const principal = { installationId: "inst", shopId: "shop", canonicalSiteUrl: "https://woo.invalid", credentialVersion: 1 };
const textBody = JSON.stringify({ kind: "HUMAN_TEXT", expectedControlRevision: 1, idempotencyKey: "k1", textBody: "Hello" });
const accepted = { schemaVersion: 1, commandId: "cmd-1", conversationId: "conv-1", kind: "HUMAN_TEXT",
  state: "ACCEPTED", controlRevision: 1 };
const status = { schemaVersion: 1, commandId: "cmd-1", conversationId: "conv-1", kind: "HUMAN_TEXT", state: "SENT",
  createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:01:00Z", messageId: "msg-1",
  failureCode: null, moderationStatus: "moderation_allowed", moderationReasonCode: null };
function request(method = "POST", body = textBody, path = "/v1/merchant/conversations/conv-1/messages", headers?: string[]): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as IncomingMessage;
  req.url = path; req.method = method; req.rawHeaders = headers ?? ["content-type", "application/json"];
  return req;
}
function output() {
  let statusCode = 0; let headers: Record<string,string> = {}; let body = "";
  const response = { destroyed: false, headersSent: false,
    writeHead(status: number, values: Record<string,string>) { statusCode = status; headers = values; },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  return { response, result: () => ({ statusCode, headers, data: JSON.parse(body) as unknown }) };
}
function instance(failure?: Error) {
  const calls: string[] = [];
  const route = createMerchantConversationMessageRoutes({
    authenticator: { async authenticate() { calls.push("auth");
      if (failure instanceof WooUnauthenticatedError) throw failure;
      return principal; } } as never,
    admission: { async admit() { calls.push("admit"); if (failure) throw failure; return { code: 202, response: accepted }; } } as never,
    status: { async read() { calls.push("read"); if (failure) throw failure; return status; } } as never,
    followUp: { async read() { calls.push("choices"); if (failure) throw failure;
      return { schemaVersion: 1, templates: [{ name: "moda_follow_up_no_offer", language: "en" }] }; } } as never,
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  return { route, calls };
}

test("authentication precedes body parsing; POST returns 202 but never reports provider success", async () => {
  const a = instance(), response = output();
  assert.equal(await a.route.handle(request(), response.response), true);
  assert.equal(response.result().statusCode, 202);
  assert.deepEqual(response.result().data, accepted);
  assert.equal(response.result().headers["cache-control"], "no-store");
  assert.deepEqual(a.calls, ["auth", "admit"]);
  const denied = instance(new WooUnauthenticatedError()), invalid = output();
  await denied.route.handle(request("POST", "not-json"), invalid.response);
  assert.deepEqual(denied.calls, ["auth"]);
  assert.equal(invalid.result().statusCode, 401);
});
test("GET exposes persisted state/moderation without invoking admission", async () => {
  const a = instance(), response = output();
  assert.equal(await a.route.handle(request("GET", "", "/v1/merchant/conversations/conv-1/send-commands/cmd-1"), response.response), true);
  assert.equal(response.result().statusCode, 200);
  assert.deepEqual(response.result().data, status);
  assert.deepEqual(a.calls, ["auth", "read"]);
});
test("rejection/error envelopes are safe, bounded and do not reveal connection strings", async () => {
  for (const [err, code, body] of [
    [new SendHttpError(409, "idempotency_conflict"), 409, { error: "idempotency_conflict" }],
    [new SendHttpError(403, "human_messaging_suspended"), 403, { error: "human_messaging_suspended" }],
    [new SendHttpError(404, "not_found"), 404, { error: "not_found" }],
    [new Error("postgres://secret:token@host"), 500, { error: "internal_error" }],
  ] as const) {
    const t = instance(err), out = output(); await t.route.handle(request(), out.response);
    assert.equal(out.result().statusCode, code); assert.deepEqual(out.result().data, body);
    assert.doesNotMatch(JSON.stringify(out.result()), /secret:token/);
  }
  for (const bad of [
    request("POST", '{"kind": "HUMAN_TEXT", "kind":"HUMAN_TEXT"}'),
    request("POST", textBody, "/v1/merchant/conversations/conv-1/messages?shopId=foreign"),
    request("POST", textBody, "/v1/merchant/conversations/conv-1/messages", ["content-type", "text/plain"]),
    request("POST", textBody, "/v1/merchant/conversations/conv-1/messages", ["content-type", "application/json", "content-type", "application/json"]),
    request("POST", "x".repeat(6145)),
  ]) {
    const t = instance(), out = output(); await t.route.handle(bad, out.response);
    assert.ok([400,413].includes(out.result().statusCode)); assert.deepEqual(t.calls, ["auth"]);
  }
});

test("follow-up GET shares installation authentication, no-store and bounded read validation", async () => {
  const path = "/v1/merchant/conversations/conv-1/follow-up-templates";
  const ok = instance(), result = output();
  assert.equal(await ok.route.handle(request("GET", "", path), result.response), true);
  assert.equal(result.result().statusCode, 200);
  assert.deepEqual(result.result().data, { schemaVersion: 1,
    templates: [{ name: "moda_follow_up_no_offer", language: "en" }] });
  assert.equal(result.result().headers["cache-control"], "no-store");
  assert.deepEqual(ok.calls, ["auth", "choices"]);
  const unauthorized = instance(new WooUnauthenticatedError()), out = output();
  await unauthorized.route.handle(request("GET", "", path), out.response);
  assert.equal(out.result().statusCode, 401);
  assert.deepEqual(unauthorized.calls, ["auth"]);
  for (const r of [
    request("GET", "", path + "?shop=other"),
    request("GET", "", path, ["content-length", "2"]),
    request("GET", "", "/v1/merchant/conversations/%2F/follow-up-templates"),
  ]) {
    const service = instance(), outputValue = output();
    await service.route.handle(r, outputValue.response);
    assert.equal(outputValue.result().statusCode, 400);
    assert.deepEqual(service.calls, ["auth"]);
  }
});
