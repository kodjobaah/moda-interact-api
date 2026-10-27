import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { createMerchantRecoveryPolicyRoute } from "../../../../src/merchant/recovery-policy/routes.js";
import { RecoveryPolicyConflictError, RecoveryPolicyIntegrityError,
  MERCHANT_RECOVERY_POLICY_ROUTE_PATH } from "../../../../src/merchant/recovery-policy/contract.js";

const principal = { shopId: "shop_a", installationId: "woo_a", credentialVersion: 2,
  canonicalSiteUrl: "https://woo.example" };
const policy = { recoveryDelayMinutes: 30, recoveryOfferMode: "NONE", followUpEnabled: false, followUpDelayMinutes: null };
const projected = { schemaVersion: 2, revision: "UNCONFIGURED", merchant: policy, effective: policy,
  source: "MERCHANT", overrideActive: false, offerSelectionAvailable: false,
  notifyOnInitialRecoveryOutreach: false };
const update = { expectedRevision: "UNCONFIGURED", recoveryDelayMinutes: 50, followUpEnabled: true,
  followUpDelayMinutes: 120, notifyOnInitialRecoveryOutreach: true };

function request(method: "GET" | "PUT", url = MERCHANT_RECOVERY_POLICY_ROUTE_PATH,
  data: unknown = update, headers?: string[]): IncomingMessage {
  const body = Buffer.from(JSON.stringify(data));
  const rawHeaders = headers ?? (method === "PUT" ? ["Content-Type", "application/json"] : []);
  return { method, url, rawHeaders,
    async *[Symbol.asyncIterator]() { if (method === "PUT") yield body; },
  } as unknown as IncomingMessage;
}

function response() {
  let status = 0;
  let body = "";
  let headers: Record<string, string> = {};
  const object = { destroyed: false, headersSent: false,
    writeHead(code: number, fields: Record<string, string>) { status = code; headers = fields; },
    end(content: string) { body = content; },
  } as unknown as ServerResponse;
  return { object, result: () => ({ status, headers, body: JSON.parse(body) as Record<string, unknown> }) };
}

function make(options: { failAuth?: boolean; failService?: Error; corruptResponse?: boolean;
  throwingLogger?: boolean; logger?: { info: (event: string, fields: Record<string, unknown>) => void;
    warn: (event: string, fields: Record<string, unknown>) => void;
    error: (event: string, fields: Record<string, unknown>) => void } } = {}) {
  const calls: string[] = [];
  const logs: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const logger = options.logger ?? {
    info: (event: string, fields: Record<string, unknown>) => {
      logs.push({ level: "info", event, fields });
      if (options.throwingLogger) throw new Error("logger sink unavailable");
    },
    warn: (event: string, fields: Record<string, unknown>) => {
      logs.push({ level: "warn", event, fields });
      if (options.throwingLogger) throw new Error("logger sink unavailable");
    },
    error: (event: string, fields: Record<string, unknown>) => {
      logs.push({ level: "error", event, fields });
      if (options.throwingLogger) throw new Error("logger sink unavailable");
    },
  };
  const route = createMerchantRecoveryPolicyRoute({
    authenticator: { authenticate: async () => {
      calls.push("authenticate"); if (options.failAuth) throw new WooUnauthenticatedError(); return principal;
    } } as never,
    service: {
      read: async () => { calls.push("read"); if (options.failService) throw options.failService;
        return options.corruptResponse ? { ...projected, secret: "should-not-leak" } : projected; },
      update: async (_principal: unknown, body: unknown) => {
        calls.push("update"); assert.deepEqual(body, update);
        if (options.failService) throw options.failService;
        return projected;
      },
    } as never,
    logger: logger as never,
  });
  return { route, calls, logs, logger };
}

test("GET returns bounded merchant/effective policy and no-store cache headers", async () => {
  const testRoute = make(); const out = response();
  assert.equal(await testRoute.route.handle(request("GET"), out.object), true);
  assert.deepEqual(out.result().body, projected);
  assert.equal(out.result().status, 200);
  assert.equal(out.result().headers["cache-control"], "no-store");
  assert.deepEqual(testRoute.calls, ["authenticate", "read"]);
});

test("PUT authenticates then validates exactly the five writable fields", async () => {
  const testRoute = make(); const out = response();
  await testRoute.route.handle(request("PUT"), out.object);
  assert.equal(out.result().status, 200);
  assert.deepEqual(testRoute.calls, ["authenticate", "update"]);
});

test("wrong path or method bypasses handler", async () => {
  const t = make(); const out = response();
  assert.equal(await t.route.handle(request("GET", "/different"), out.object), false);
  assert.equal(await t.route.handle({ ...request("GET"), method: "POST" } as IncomingMessage, out.object), false);
  assert.deepEqual(t.calls, []);
});

test("invalid identity is rejected before reading input or merchant state", async () => {
  const t = make({ failAuth: true }); const out = response();
  await t.route.handle(request("PUT"), out.object);
  assert.equal(out.result().status, 401);
  assert.deepEqual(t.calls, ["authenticate"]);
});

test("queries, GET bodies, unknown update fields and wrong content type are rejected", async () => {
  for (const req of [request("GET", `${MERCHANT_RECOVERY_POLICY_ROUTE_PATH}?shopId=other`),
    request("GET", MERCHANT_RECOVERY_POLICY_ROUTE_PATH, update, ["Content-Length", "1"]),
    request("PUT", `${MERCHANT_RECOVERY_POLICY_ROUTE_PATH}?other=1`),
    request("PUT", MERCHANT_RECOVERY_POLICY_ROUTE_PATH, { ...update, shopId: "foreign" }),
    request("PUT", MERCHANT_RECOVERY_POLICY_ROUTE_PATH, update, ["Content-Type", "text/plain"]),
  ]) {
    const t = make(); const out = response();
    await t.route.handle(req, out.object);
    assert.deepEqual(out.result().body, { error: "invalid_request" });
    assert.equal(out.result().status, 400);
    assert.deepEqual(t.calls, ["authenticate"]);
  }
});

test("oversized JSON returns 413 without invoking the service", async () => {
  const t = make(); const out = response();
  await t.route.handle(request("PUT", MERCHANT_RECOVERY_POLICY_ROUTE_PATH,
    { ...update, padding: "x".repeat(2050) }), out.object);
  assert.equal(out.result().status, 413);
  assert.deepEqual(t.calls, ["authenticate"]);
});

test("CAS, unsafe offers and tenant mismatches use bounded 409 error codes", async () => {
  for (const [failure, code] of [
    [new RecoveryPolicyConflictError("recovery_policy_conflict"), "recovery_policy_conflict"],
    [new RecoveryPolicyConflictError("recovery_offer_unsupported"), "recovery_offer_unsupported"],
    [new RecoveryPolicyIntegrityError(), "recovery_policy_integrity_invalid"],
  ] as const) {
    const t = make({ failService: failure }); const out = response();
    await t.route.handle(request("PUT"), out.object);
    assert.equal(out.result().status, 409);
    assert.deepEqual(out.result().body, { error: code });
  }
});

test("corrupt service output and unexpected exceptions cannot leak private information", async () => {
  for (const t of [make({ corruptResponse: true }), make({ failService: new Error("postgres://user:pass@private") })]) {
    const out = response();
    await t.route.handle(request("GET"), out.object);
    assert.equal(out.result().status, 500);
    assert.equal(out.result().headers["cache-control"], "no-store");
    assert.equal(JSON.stringify(out.result()).includes("private"), false);
    assert.equal(JSON.stringify(out.result()).includes("should-not-leak"), false);
    const failure = t.logs.find((entry) => entry.level === "error");
    assert.equal(failure?.event, "merchant.recovery_policy.access.failed");
    assert.equal(failure?.fields.operation, "read");
    assert.equal(failure?.fields.reason, "internal");
    assert.ok(failure?.fields.error instanceof Error);
  }
});

test("unexpected read/write failures log the original error and safe operation context", async () => {
  for (const method of ["GET", "PUT"] as const) {
    const error = new Error("database persistence failed");
    const t = make({ failService: error }); const out = response();
    await t.route.handle(request(method), out.object);
    assert.equal(out.result().status, 500);
    assert.deepEqual(out.result().body, { error: "internal_error" });
    assert.equal(out.result().headers["cache-control"], "no-store");
    assert.deepEqual(t.logs.filter((entry) => entry.level === "error").map(({ event, fields }) => ({ event, fields })), [{
      event: "merchant.recovery_policy.access.failed",
      fields: { operation: method === "PUT" ? "update" : "read", reason: "internal", error },
    }]);
  }
});

test("a failing shared logger sink cannot change the sanitized 500 response", async () => {
  const error = new Error("database persistence failed");
  const t = make({ failService: error, throwingLogger: true }); const out = response();
  await t.route.handle(request("PUT"), out.object);
  assert.equal(out.result().status, 500);
  assert.deepEqual(out.result().body, { error: "internal_error" });
  assert.equal(out.result().headers["cache-control"], "no-store");
});

test("a failing logger sink cannot change successful or conflict status codes", async () => {
  const success = make({ throwingLogger: true }); const successOut = response();
  await success.route.handle(request("GET"), successOut.object);
  assert.equal(successOut.result().status, 200);

  const conflict = make({ failService: new RecoveryPolicyConflictError("recovery_policy_conflict"),
    throwingLogger: true }); const conflictOut = response();
  await conflict.route.handle(request("PUT"), conflictOut.object);
  assert.equal(conflictOut.result().status, 409);
  assert.deepEqual(conflictOut.result().body, { error: "recovery_policy_conflict" });
});
