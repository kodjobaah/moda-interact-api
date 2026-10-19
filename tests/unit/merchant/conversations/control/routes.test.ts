import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WooUnauthenticatedError } from "../../../../../src/auth/woo-installation/authenticator.js";
import {
  ConversationControlConflictError, ConversationControlIntegrityError,
  ConversationControlNotFoundError, ConversationControlSuspendedError,
} from "../../../../../src/merchant/conversations/control/contract.js";
import { createMerchantConversationControlRoute } from "../../../../../src/merchant/conversations/control/routes.js";

const principal = { installationId: "woo-1", shopId: "shop-1", canonicalSiteUrl: "https://woo.invalid", credentialVersion: 3 };
const success = { schemaVersion: 1, conversationId: "conv-1", controlMode: "HUMAN", controlRevision: 1,
  controlChangedAt: "2026-10-19T02:00:00.000Z" };

function request(payload: string | undefined = '{"targetMode":"HUMAN","expectedControlRevision":0}',
  options: { path?: string; method?: string; headers?: string[] } = {}): IncomingMessage {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(payload)]) as IncomingMessage;
  req.url = options.path ?? "/v1/merchant/conversations/conv-1/control";
  req.method = options.method ?? "POST";
  req.rawHeaders = options.headers ?? ["Content-Type", "application/json"];
  return req;
}
function response() {
  let status = 0; let headers: Record<string, string> = {}; let body = "";
  const output = { destroyed: false, headersSent: false,
    writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  return { output, result: () => ({ status, headers, body: JSON.parse(body) as Record<string, unknown> }) };
}
function route(failure?: Error, reply: unknown = success) {
  const calls: unknown[] = [];
  const instance = createMerchantConversationControlRoute({
    authenticator: { authenticate: async () => { calls.push("auth"); if (failure instanceof WooUnauthenticatedError) throw failure; return principal; } } as never,
    service: { change: async (who: unknown, id: string, body: unknown) => {
      calls.push([who, id, body]); if (failure && !(failure instanceof WooUnauthenticatedError)) throw failure;
      return reply;
    } } as never,
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  return { instance, calls };
}

test("POST authenticates before reading body, and returns bounded versioned response", async () => {
  const a = route(); const out = response();
  assert.equal(await a.instance.handle(request(), out.output), true);
  assert.deepEqual(out.result().body, success);
  assert.equal(out.result().headers["cache-control"], "no-store");
  assert.deepEqual(a.calls, ["auth", [principal, "conv-1", { targetMode: "HUMAN", expectedControlRevision: 0 }]]);
  const denied = route(new WooUnauthenticatedError()); const deniedOut = response();
  await denied.instance.handle(request(), deniedOut.output);
  assert.equal(deniedOut.result().status, 401);
  assert.deepEqual(denied.calls, ["auth"]);
  assert.equal(await denied.instance.handle(request(undefined, { method: "GET" }), response().output), false);
});

test("all invalid bodies, duplicate keys and invalid IDs stop before service", async () => {
  for (const payload of [
    '{"targetMode":"HUMAN","expectedControlRevision":0,"shopId":"foreign"}',
    '{"targetMode":"AI","targetMode":"HUMAN","expectedControlRevision":0}',
    '{"targetMode":"HUMAN","expectedControlRevision":0,"expectedControlRevision":1}',
    '{"targetMode":"AI","\\u0074argetMode":"HUMAN","expectedControlRevision":0}',
    '{"targetMode":"HUMAN","expectedControlRevision":"0"}',
    '{"targetMode":"HUMAN","expectedControlRevision":null}',
    '{"targetMode":"HUMAN","expectedControlRevision":0,}',
    '{"targetMode":"HUMAN","expectedControlRevision":-1}',
    '{"targetMode":"HUMAN"}', '["HUMAN",0]', '{"targetMode":"HUMAN","expectedControlRevision":0}{}',
  ]) {
    const t = route(); const out = response();
    await t.instance.handle(request(payload), out.output);
    assert.equal(out.result().status, 400, payload);
    assert.deepEqual(t.calls, ["auth"]);
  }
  for (const [req, status] of [
    [request(undefined, { path: "/v1/merchant/conversations/%2F/control" }), 400],
    [request(undefined, { path: "/v1/merchant/conversations/conv-1/control?shopId=foreign" }), 400],
    [request(undefined, { headers: ["Content-Type", "text/plain"] }), 400],
    [request(undefined, { headers: ["Content-Type", "application/json", "content-type", "application/json"] }), 400],
    [request("x".repeat(513)), 413],
    [request(""), 400],
  ] as const) {
    const t = route(); const out = response();
    await t.instance.handle(req, out.output);
    assert.equal(out.result().status, status);
    assert.equal(t.calls.length, 1);
  }
});

test("auth, not-found, stale, suspended and integrity errors use stable nonenumerating codes", async () => {
  for (const [error, status, body] of [
    [new ConversationControlNotFoundError(), 404, { error: "not_found" }],
    [new ConversationControlSuspendedError(), 403, { error: "human_messaging_suspended" }],
    [new ConversationControlIntegrityError(), 409, { error: "conversation_control_integrity_invalid" }],
    [new ConversationControlConflictError("stale_control_revision", { controlMode: "AI", controlRevision: 3 }), 409,
      { error: "stale_control_revision", controlMode: "AI", controlRevision: 3 }],
    [new Error("postgres://private:secret@host"), 500, { error: "internal_error" }],
  ] as const) {
    const t = route(error); const out = response();
    await t.instance.handle(request(), out.output);
    assert.equal(out.result().status, status);
    assert.deepEqual(out.result().body, body);
    assert.doesNotMatch(JSON.stringify(out.result()), /private:secret/);
  }
  const wrong = route(undefined, { ...success, bearer: "do-not-leak" }); const out = response();
  await wrong.instance.handle(request(), out.output);
  assert.deepEqual(out.result().body, { error: "conversation_control_integrity_invalid" });
});
