import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWooConsentStatusRoute } from "../../../../src/woocommerce/consent-status/routes.js";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { WOO_CONSENT_STATUS_PATH, WOO_CONSENT_STATUS_VERSION } from "../../../../src/woocommerce/consent-status/contract.js";

const principal = { installationId: "installed", shopId: "shop", canonicalSiteUrl: "https://woo.test", credentialVersion: 1 };
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
