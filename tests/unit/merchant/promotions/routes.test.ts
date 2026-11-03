import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { createLogger, LOG_VALUE_LIMITS, type StructuredLogger, type LogRecord } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import {
  PROMOTIONS_PATH, PROMOTION_SELECTION_PATH, PromotionDomainError,
} from "../../../../src/merchant/promotions/contract.js";
import { createMerchantPromotionsRoutes } from "../../../../src/merchant/promotions/routes.js";
import { read, selection, revision } from "./fixtures.js";

const principal = { shopId: "woo-shop", canonicalSiteUrl: "https://woo.invalid", installationId: "woo-i", credentialVersion: 1 };
const payload = { campaignId: "camp", expectedRevision: revision };
function request(method: string, url: string, body: unknown = payload, headers?: string[]): IncomingMessage {
  const bytes = method === "PUT" ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  return Object.assign(Readable.from(bytes.length ? [bytes] : []), {
    method, url, rawHeaders: headers ?? (method === "PUT" ? ["Content-Type", "application/json"] : []),
  }) as IncomingMessage;
}
function response() {
  let status = 0; let headers: Record<string, string> = {}; let body = "";
  const raw = { destroyed: false, headersSent: false,
    writeHead(code: number, h: Record<string, string>) { status = code; headers = h; },
    end(data: string) { body = data; },
  } as unknown as ServerResponse;
  return { raw, result: () => ({ status, headers, body: JSON.parse(body) as Record<string, unknown> }) };
}
function factory(options: { unauthorized?: boolean; fail?: Error; corrupt?: boolean; logger?: StructuredLogger } = {}) {
  const calls: string[] = []; const logs: Record<string, unknown>[] = [];
  const route = createMerchantPromotionsRoutes({
    authenticator: { authenticate: async () => { calls.push("auth");
      if (options.unauthorized) throw new WooUnauthenticatedError(); return principal; } } as never,
    service: {
      read: async (p: unknown, query: unknown) => { calls.push("read"); assert.deepEqual(p, principal);
        assert.deepEqual(query, { offerPage: 1, historyPage: 1, locale: "en" });
        if (options.fail) throw options.fail;
        return options.corrupt ? { ...read, secret: "postgres://private" } : read; },
      select: async (p: unknown, value: unknown) => { calls.push("select"); assert.deepEqual(p, principal);
        assert.deepEqual(value, payload); if (options.fail) throw options.fail;
        return { schemaVersion: 1, revision, selection }; },
    } as never,
    logger: options.logger ?? { info: (_: string, data: Record<string, unknown>) => logs.push(data),
      warn: (_: string, data: Record<string, unknown>) => logs.push(data),
      error: (_: string, data: Record<string, unknown>) => logs.push(data) } as never,
  });
  return { route, calls, logs };
}
test("GET and PUT have installation auth, versioned payloads and private no-store headers", async () => {
  const f = factory(); const readResult = response();
  assert.equal(await f.route.handle(request("GET", PROMOTIONS_PATH), readResult.raw), true);
  assert.equal(readResult.result().status, 200);
  assert.deepEqual(readResult.result().body, read);
  assert.equal(readResult.result().headers["cache-control"], "private, no-store");
  const writeResult = response(); await f.route.handle(request("PUT", PROMOTION_SELECTION_PATH), writeResult.raw);
  assert.equal(writeResult.result().status, 200);
  assert.deepEqual(writeResult.result().body, { schemaVersion: 1, revision, selection });
  assert.deepEqual(f.calls, ["auth", "read", "auth", "select"]);
  assert.equal(JSON.stringify(f.logs).includes("credential"), false);
});
test("unauthorized installations never reach the promotion service", async () => {
  const f = factory({ unauthorized: true }); const r = response();
  await f.route.handle(request("PUT", PROMOTION_SELECTION_PATH), r.raw);
  assert.equal(r.result().status, 401);
  assert.deepEqual(f.calls, ["auth"]);
});
test("invalid, forged, oversized and ambiguous requests fail before accessing persistence", async () => {
  const cases: Array<[IncomingMessage, number]> = [
    [request("GET", `${PROMOTIONS_PATH}?shopId=foreign`), 400],
    [request("GET", `${PROMOTIONS_PATH}?historyPage=1&historyPage=2`), 400],
    [request("GET", PROMOTIONS_PATH, payload, ["Content-Length", "4"]), 400],
    [request("PUT", PROMOTION_SELECTION_PATH, { ...payload, shopId: "foreign" }), 400],
    [request("PUT", PROMOTION_SELECTION_PATH, payload, ["Content-Type", "application/json", "Content-Type", "application/json"]), 400],
    [request("PUT", `${PROMOTION_SELECTION_PATH}?locale=en`), 400],
    [request("PUT", PROMOTION_SELECTION_PATH, { ...payload, filler: "x".repeat(5000) }), 413],
  ];
  for (const [req, status] of cases) {
    const f = factory(); const r = response(); await f.route.handle(req, r.raw);
    assert.equal(r.result().status, status);
    assert.deepEqual(f.calls, ["auth"]);
    assert.equal(r.result().headers["cache-control"], "private, no-store");
  }
});
test("stable 409/422 and integrity errors have no secret leakage", async () => {
  for (const [error, status, code] of [
    [new PromotionDomainError(409, "promotion_revision_conflict"), 409, "promotion_revision_conflict"],
    [new PromotionDomainError(409, "promotion_selection_locked"), 409, "promotion_selection_locked"],
    [new PromotionDomainError(422, "promotion_exhausted"), 422, "promotion_exhausted"],
    [new Error("secret credential postgres://private"), 500, "internal_error"],
  ] as const) {
    const f = factory({ fail: error }); const r = response(); await f.route.handle(request("PUT", PROMOTION_SELECTION_PATH), r.raw);
    assert.equal(r.result().status, status); assert.deepEqual(r.result().body, { error: code });
    assert.equal(JSON.stringify(f.logs).includes("secret"), false);
  }
  const r = response(); await factory({ corrupt: true }).route.handle(request("GET", PROMOTIONS_PATH), r.raw);
  assert.deepEqual(r.result().body, { error: "promotion_integrity_invalid" });
});
test("unknown paths and HTTP methods fall through untouched", async () => {
  const f = factory(); const r = response();
  assert.equal(await f.route.handle(request("POST", PROMOTIONS_PATH), r.raw), false);
  assert.equal(await f.route.handle(request("GET", "/outside"), r.raw), false);
  assert.deepEqual(f.calls, []);
});


test("promotion routes retain wrapped database cause/code through the real Shared sink", async () => {
  for (const method of ["GET", "PUT"]) {
    const records: LogRecord[] = [];
    const databaseError = new Prisma.PrismaClientKnownRequestError(
      "Original serialization failure while selecting promotional credits",
      { code: "P2034", clientVersion: "test" },
    );
    const wrapped = new PromotionDomainError(409, "promotion_revision_conflict", { cause: databaseError });
    const f = factory({ fail: wrapped, logger: createLogger({
      serviceName: "api006-promotions-test", environment: "test", sink: record => records.push(record),
    }) });
    const r = response();
    await f.route.handle(request(method, method === "GET" ? PROMOTIONS_PATH : PROMOTION_SELECTION_PATH), r.raw);
    assert.equal(r.result().status, 409);
    assert.deepEqual(r.result().body, { error: "promotion_revision_conflict" });
    assert.equal(r.result().headers["cache-control"], "private, no-store");
    assert.equal(records.length, 1);
    assert.equal(records[0]!.event, "merchant.promotions.access.denied");
    assert.equal(records[0]!.data?.databaseCode, "P2034");
    assert.deepEqual(records[0]!.data?.errorCause, {
      name: databaseError.name, message: databaseError.message,
    });
    assert.equal(wrapped.cause, databaseError);
    assert.equal(records[0]!.data?.redactionApplied, false);
    assert.ok(!JSON.stringify(r.result().body).includes(databaseError.message));
  }
});

test("promotion diagnostics redact sensitive cause text and omit arbitrary database payloads", async () => {
  const records: LogRecord[] = [];
  const original = "Original serialization failure; postgres://reader:db-password@private/db " +
    "Bearer bearer-value; token=token-value; password=password-value; user@example.invalid +447700900123";
  const databaseError = new Prisma.PrismaClientKnownRequestError(original, {
    code: "P2034", clientVersion: "test",
    meta: { query: "SELECT customer-body", password: "meta-value", payload: { customer: "customer-value" } },
  });
  const wrapped = new PromotionDomainError(409, "promotion_revision_conflict", { cause: databaseError });
  const f = factory({ fail: wrapped, logger: createLogger({
    serviceName: "api006-promotions-test", environment: "test", sink: record => records.push(record),
  }) });
  const r = response();
  await f.route.handle(request("PUT", PROMOTION_SELECTION_PATH), r.raw);
  const privateLog = JSON.stringify(records);
  for (const sensitive of ["postgres://", "db-password", "bearer-value", "token-value", "password-value",
    "user@example.invalid", "447700900123", "customer-body", "meta-value", "customer-value"]) {
    assert.equal(privateLog.includes(sensitive), false, sensitive);
  }
  assert.ok(privateLog.includes("Original serialization failure"));
  assert.equal(records[0]!.data?.databaseCode, "P2034");
  assert.equal(records[0]!.data?.redactionApplied, true);
  assert.deepEqual(r.result().body, { error: "promotion_revision_conflict" });
  assert.equal(databaseError.message, original);
  assert.equal(wrapped.cause, databaseError);

  const longError = new Error("x".repeat(LOG_VALUE_LIMITS.maxStringLength - 8) + " token=" + "boundary-value".repeat(100));
  const boundedRecords: LogRecord[] = [];
  const bounded = factory({ fail: new PromotionDomainError(409, "promotion_revision_conflict", { cause: longError }),
    logger: createLogger({ serviceName: "api006-promotions-test", environment: "test",
      sink: record => boundedRecords.push(record) }) });
  const boundedResponse = response();
  await bounded.route.handle(request("PUT", PROMOTION_SELECTION_PATH), boundedResponse.raw);
  assert.equal(boundedResponse.result().status, 409);
  assert.equal(JSON.stringify(boundedRecords).includes("boundary-value"), false);
  const cause = boundedRecords[0]!.data?.errorCause as { message: string };
  assert.ok(cause.message.length <= LOG_VALUE_LIMITS.maxStringLength + 20);
  assert.equal(boundedRecords[0]!.data?.databaseCode, undefined, "no database code may be invented");
});
