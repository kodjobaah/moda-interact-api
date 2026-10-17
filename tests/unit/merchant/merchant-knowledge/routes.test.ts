import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { MERCHANT_KNOWLEDGE_PATH, MerchantKnowledgeReadError } from "../../../../src/merchant/merchant-knowledge/contract.js";
import { createMerchantKnowledgeRoute } from "../../../../src/merchant/merchant-knowledge/routes.js";

const principal = { shopId: "shop", installationId: "installation", canonicalSiteUrl: "https://woo.example", credentialVersion: 1 };
function request(url = MERCHANT_KNOWLEDGE_PATH, method = "GET", rawHeaders: string[] = []): IncomingMessage {
  return { url, method, rawHeaders } as unknown as IncomingMessage;
}
function response() {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  const object = { writeHead(code: number, next: Record<string, string>) { status = code; headers = next; },
    end(chunk: string) { body = chunk; }, destroyed: false, headersSent: false } as unknown as ServerResponse;
  return { object, read: () => ({ status, headers, body: JSON.parse(body) as Record<string, unknown> }) };
}
function setup(opts: { deny?: boolean; failure?: Error } = {}) {
  const called: Array<unknown> = [];
  const logs: unknown[] = [];
  const handler = createMerchantKnowledgeRoute({
    authenticator: { authenticate: async () => {
      called.push("auth");
      if (opts.deny) throw new WooUnauthenticatedError();
      return principal;
    } } as never,
    service: { read: async (_: unknown, position: number | null) => {
      called.push(position);
      if (opts.failure) throw opts.failure;
      return { schemaVersion: 1, state: "MERCHANT_DISABLED", sources: [], nextPosition: null };
    } } as never,
    logger: { info: (_: unknown, fields: unknown) => logs.push(fields),
      warn: (_: unknown, fields: unknown) => logs.push(fields),
      error: (_: unknown, fields: unknown) => logs.push(fields) } as never,
  });
  return { handler, called, logs };
}

test("read-only route authenticates, returns no-store and bounded merchant state", async () => {
  const app = setup(); const result = response();
  assert.equal(await app.handler.handle(request(), result.object), true);
  assert.equal(result.read().status, 200);
  assert.equal(result.read().headers["cache-control"], "no-store");
  assert.equal(result.read().body.state, "MERCHANT_DISABLED");
  assert.deepEqual(app.called, ["auth", null]);
});

test("afterPosition is the only permitted query field; owner comes from principal", async () => {
  const app = setup(); const result = response();
  await app.handler.handle(request(`${MERCHANT_KNOWLEDGE_PATH}?afterPosition=123`), result.object);
  assert.deepEqual(app.called, ["auth", 123]);
  for (const url of ["?shopId=other", "?afterPosition=-1", "?afterPosition=1&afterPosition=2", "?afterPosition=2147483648"] ) {
    const testApp = setup(); const output = response();
    await testApp.handler.handle(request(`${MERCHANT_KNOWLEDGE_PATH}${url}`), output.object);
    assert.equal(output.read().status, 400);
    assert.deepEqual(output.read().body, { error: "invalid_request" });
    assert.deepEqual(testApp.called, ["auth"]);
  }
});

test("method/path bypass and GET bodies rejected", async () => {
  const app = setup(); const output = response();
  assert.equal(await app.handler.handle(request(MERCHANT_KNOWLEDGE_PATH, "POST"), output.object), false);
  assert.equal(await app.handler.handle(request("/v1/merchant/other"), output.object), false);
  const body = response();
  assert.equal(await app.handler.handle(request(MERCHANT_KNOWLEDGE_PATH, "GET", ["Content-Length", "1"]), body.object), true);
  assert.equal(body.read().status, 400);
});

test("bad credential, stale principal, integration errors and unknown failures stay bounded", async () => {
  for (const [options, code, status] of [
    [{ deny: true }, "unauthorized", 401],
    [{ failure: new MerchantKnowledgeReadError(409, "merchant_knowledge_integrity_invalid") }, "merchant_knowledge_integrity_invalid", 409],
    [{ failure: new MerchantKnowledgeReadError(503, "merchant_knowledge_unavailable") }, "merchant_knowledge_unavailable", 503],
    [{ failure: new Error("POSTGRES_PASSWORD=secret") }, "merchant_knowledge_unavailable", 503],
  ] as const) {
    const app = setup(options); const output = response();
    await app.handler.handle(request(), output.object);
    assert.equal(output.read().status, status);
    assert.deepEqual(output.read().body, { error: code });
    assert.equal(JSON.stringify(app.logs).includes("secret"), false);
  }
});
