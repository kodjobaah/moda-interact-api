import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, type LogRecord } from "@modainteract/moda-interact-shared/logging";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWooConsentStatusRoute } from "../../../../src/woocommerce/consent-status/routes.js";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { WOO_CONSENT_STATUS_PATH, WOO_CONSENT_STATUS_VERSION } from "../../../../src/woocommerce/consent-status/contract.js";

const principal = { installationId: "woo-installation-private-fixture", shopId: "woo-shop-private-fixture", canonicalSiteUrl: "https://woo.test", credentialVersion: 1 };
const body = { schemaVersion: WOO_CONSENT_STATUS_VERSION,
  canonicalPhone: "447400123456", grantEventId: "woo-consent-01" };
type Dependencies = Parameters<typeof createWooConsentStatusRoute>[0];
type Log = { type: string; event: string; data: Record<string, unknown> };
const logs: Log[] = [];
const logger = {
  info(event: string, data: Record<string, unknown>) { logs.push({ type: "info", event, data }); },
  warn(event: string, data: Record<string, unknown>) { logs.push({ type: "warn", event, data }); },
  error(event: string, data: Record<string, unknown>) { logs.push({ type: "error", event, data }); },
} as Dependencies["logger"];

async function post(deps: Dependencies, payload: unknown = body,
  changes: { raw?: string; path?: string; headers?: Record<string, string>; method?: string } = {}) {
  const route = createWooConsentStatusRoute(deps);
  const server = createServer((req, res) => {
    void route.handle(req, res).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await fetch(`http://127.0.0.1:${port}${changes.path ?? WOO_CONSENT_STATUS_PATH}`, {
      method: changes.method ?? "POST",
      headers: { "content-type": "application/json", ...changes.headers },
      ...(changes.method === "GET" ? {} : { body: changes.raw ?? JSON.stringify(payload) }),
    });
    const text = await result.text();
    return { status: result.status, body: text ? JSON.parse(text) as Record<string, unknown> : {},
      noStore: result.headers.get("cache-control") };
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
const deps = (read: Dependencies["service"]["read"] = async () => ({ schemaVersion: WOO_CONSENT_STATUS_VERSION,
  state: "CONFIRMED_GRANTED" }), authenticate: Dependencies["authenticator"]["authenticate"] = async () => principal): Dependencies =>
  ({ authenticator: { authenticate }, service: { read }, logger });

test("authenticated status route returns exact bounded no-store status and emits domain diagnostics", async () => {
  logs.splice(0);
  let queryCalls = 0;
  const result = await post(deps(async (current, proof) => {
    queryCalls++;
    assert.deepEqual(current, principal);
    assert.deepEqual(proof, body);
    return { schemaVersion: WOO_CONSENT_STATUS_VERSION, state: "CONFIRMED_GRANTED" };
  }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { schemaVersion: WOO_CONSENT_STATUS_VERSION, state: "CONFIRMED_GRANTED" });
  assert.equal(result.noStore, "no-store");
  assert.equal(queryCalls, 1);
  assert.equal(logs.at(-1)?.event, "woocommerce.consent_status.read");
  assert.equal(logs.at(-1)?.data.transactionCount, 0);
  const record = JSON.stringify(logs);
  assert.equal(record.includes(body.canonicalPhone), false);
  assert.equal(record.includes(body.grantEventId), false);
});

test("missing evidence uses exactly UNVERIFIED, not a 404 or a leaking reason", async () => {
  const response = await post(deps(async () => ({ schemaVersion: WOO_CONSENT_STATUS_VERSION, state: "UNVERIFIED" })));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { schemaVersion: WOO_CONSENT_STATUS_VERSION, state: "UNVERIFIED" });
});

test("authentication occurs before body parsing; no unauthenticated database read", async () => {
  let calls = 0;
  const response = await post(deps(async () => { calls++; throw new Error("should not run"); },
    async () => { throw new WooUnauthenticatedError(); }), { invalid: true });
  assert.deepEqual([response.status, response.body.error, calls], [401, "unauthorized", 0]);
  assert.equal(response.noStore, "no-store");
});

test("strict bounded v1 rejects unknown fields, duplicate JSON keys, malformed/missing headers", async () => {
  let calls = 0;
  const d = deps(async () => { calls++; throw new Error("should not run"); });
  const invalids = [
    { ...body, customerId: "forged" },
    { ...body, schemaVersion: "woo.whatsapp-consent-status.v2" },
    { ...body, grantEventId: "bad\\n" },
  ];
  for (const item of invalids) assert.equal((await post(d, item)).status, 400);
  assert.equal((await post(d, body, { raw: '{"schemaVersion":"woo.whatsapp-consent-status.v1","canonicalPhone":"447400123456","canonicalPhone":"447400123456","grantEventId":"woo-01"}' })).status, 400);
  assert.equal((await post(d, body, { raw: '{"schemaVersion":"woo.whatsapp-consent-status.v1","canonicalPhone":"447400123456","grantEventId":"woo-01","grantEventId":"woo-02"}' })).status, 400);
  assert.equal((await post(d, body, { path: `${WOO_CONSENT_STATUS_PATH}?x=1` })).status, 400);
  assert.equal((await post(d, body, { headers: { "content-type": "text/plain" } })).status, 400);
  assert.equal((await post(d, body, { headers: { "content-encoding": "gzip" } })).status, 400);
  assert.equal((await post(d, body, { raw: JSON.stringify({ ...body, filler: "x".repeat(600) }) })).status, 413);
  assert.equal((await post(d, body, { method: "GET" })).status, 404);
  assert.equal(calls, 0);
});

test("DB/SDK error is logged intact and client sees only a no-store 503", async () => {
  logs.splice(0);
  const failure = Object.assign(new Error("Prisma original connection timeout"), { code: "P2028", cause: "socket refused" });
  const response = await post(deps(async () => { throw failure; }));
  assert.deepEqual([response.status, response.body.error], [503, "consent_status_unavailable"]);
  assert.equal(response.noStore, "no-store");
  const log = logs.at(-1)!;
  assert.equal(log.event, "woocommerce.consent_status.unavailable");
  assert.equal(log.data.errorMessage, failure.message);
  assert.equal(log.data.errorCode, "P2028");
  assert.equal(log.data.errorCause, "socket refused");
  assert.equal(log.data.stage, "database_read");
  assert.equal(JSON.stringify(response.body).includes("Prisma"), false);
});

test("shared diagnostics redact recipient-like values without replacing provider error codes", async () => {
  logs.splice(0);
  const failure = Object.assign(new Error("Prisma timeout for +447400123456"), { code: "P1008" });
  const response = await post(deps(async () => { throw failure; }));
  assert.equal(response.status, 503);
  const entry = logs.at(-1)!;
  assert.equal(entry.data.errorCode, "P1008");
  assert.match(String(entry.data.errorMessage), /Prisma timeout for \[REDACTED_PHONE\]/);
  assert.equal(JSON.stringify(entry).includes("447400123456"), false);
});

test("provider diagnostics keep original failure metadata but redact exact proof, installation, token and email", async () => {
  logs.splice(0);
  const secret = "test-access-token-not-for-logging";
  const error = Object.assign(new Error(
    `Prisma P2028 for ${body.grantEventId} on ${principal.installationId} ` +
    `${principal.shopId} ${principal.canonicalSiteUrl} ${body.canonicalPhone} ` +
    `support@example.test Authorization: Bearer ${secret}`,
  ), {
    code: "P2028",
    cause: new Error(`socket closed while reading ${body.grantEventId}; password=${secret}`),
    status: 504,
  });
  const result = await post(deps(async () => { throw error; }));
  assert.deepEqual([result.status, result.body, result.noStore],
    [503, { error: "consent_status_unavailable" }, "no-store"]);
  const logged = logs.at(-1);
  assert.equal(logged?.event, "woocommerce.consent_status.unavailable");
  assert.equal(logged?.data.errorCode, "P2028");
  assert.equal(logged?.data.providerHttpStatus, 504);
  assert.match(String(logged?.data.errorMessage), /Prisma P2028 for/);
  assert.match(String(logged?.data.errorCause && JSON.stringify(logged.data.errorCause)), /socket closed/);
  const diagnostic = JSON.stringify(logged);
  for (const privateValue of [body.grantEventId, principal.installationId, principal.shopId,
    principal.canonicalSiteUrl, body.canonicalPhone, secret, "support@example.test"]) {
    assert.equal(diagnostic.includes(privateValue), false, `diagnostic exposed a private test value`);
  }
  assert.equal(diagnostic.includes("[REDACTED_IDENTITY]"), true);
  assert.equal(diagnostic.includes("[REDACTED_TOKEN]"), true);
  assert.equal(diagnostic.includes("[REDACTED_EMAIL]"), true);
  // Reject partial Bearer masking as well as a leak of the full token.
  assert.equal(diagnostic.includes("access-token-not-for-logging"), false);
});

test("object-shaped SDK causes never stringify untrusted arbitrary provider response fields", async () => {
  logs.splice(0);
  const failure = Object.assign(new Error("Prisma query failed"), {
    code: "P1001",
    cause: { code: "ECONNRESET", message: `query ${body.grantEventId} failed`,
      responseBody: "secret personal-provider-body" },
  });
  assert.equal((await post(deps(async () => { throw failure; }))).status, 503);
  const diagnostic = JSON.stringify(logs.at(-1));
  assert.match(diagnostic, /ECONNRESET/);
  assert.equal(diagnostic.includes(body.grantEventId), false);
  assert.equal(diagnostic.includes("secret personal-provider-body"), false);
});

test("Shared logs retain the database reason and redact customer and account identifiers", async () => {
  const customerId = "7abf4b48-a7a1-4e70-bfab-e5fed16303e8";
  const accountId = "private-account-value";
  const cause = new Error(`Socket closed for accountId=${accountId}`);
  const failure = Object.assign(new Error(`Connection refused for customerId=${customerId}`, { cause }), {
    code: "P1001", status: 502,
  });
  const records: LogRecord[] = [];
  const result = await post({
    ...deps(async () => { throw failure; }),
    logger: createLogger({ serviceName: "consent-status-test", environment: "test",
      sink: record => records.push(record) }),
  });
  assert.deepEqual(result, { status: 503, body: { error: "consent_status_unavailable" }, noStore: "no-store" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.data?.errorCode, "P1001");
  assert.equal(records[0]?.data?.providerHttpStatus, 502);
  assert.match(String(records[0]?.data?.errorStack), /Connection refused/);
  const diagnostic = JSON.stringify(records);
  assert.match(diagnostic, /Socket closed/);
  assert.equal(diagnostic.includes(customerId), false);
  assert.equal(diagnostic.includes(accountId), false);
});
