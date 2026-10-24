import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWooConsentRoute } from "../../../../src/woocommerce/consent/routes.js";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";
import { WOO_CONSENT_PATH, type WooConsentEvent } from "../../../../src/woocommerce/consent/contract.js";

async function requestRoute(deps: Parameters<typeof createWooConsentRoute>[0], body: unknown,
  settings: { headers?: Record<string, string>; path?: string } = {}) {
  const route = createWooConsentRoute(deps);
  const server = createServer((req, res) => { void route.handle(req, res).then(handled => {
    if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
  }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${settings.path ?? WOO_CONSENT_PATH}`, {
      method: "POST", headers: { "content-type": "application/json", ...settings.headers },
      body: JSON.stringify(body),
    });
    return { status: resp.status, json: await resp.json() as Record<string, unknown>,
      cache: resp.headers.get("cache-control") };
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
const principal = { shopId: "shop-1", installationId: "install-1", canonicalSiteUrl: "https://woo.example", credentialVersion: 1 };
const logger = { info() {}, warn() {}, error() {} } as never;

test("consent POST authenticates before processing and sends no-store only after commit", async () => {
  let records = 0;
  const deps = { authenticator: { authenticate: async () => principal }, logger,
    service: { record: async () => { records++;
      return { schemaVersion: "woo.whatsapp-consent.v2" as const, status: "recorded" as const,
        decision: "GRANT" as const, consentRevision: "1", decisionSequence: "1" }; } } };
  const result = await requestRoute(deps, consentEvent());
  assert.equal(result.status, 200);
  assert.equal(result.json.status, "recorded");
  assert.equal(result.cache, "no-store");
  assert.equal(records, 1);
  assert.equal((await requestRoute(deps, { ...consentEvent(), shopId: "spoof" })).status, 400);
  assert.equal((await requestRoute(deps, consentEvent(), { path: `${WOO_CONSENT_PATH}?x=1` })).status, 400);
  assert.equal(records, 1);
});

test("revoked credentials, DB outage and malformed extra fields fail closed", async () => {
  let records = 0;
  const denied = await requestRoute({ authenticator: { authenticate: async () => { throw new WooUnauthenticatedError(); } },
    service: { record: async () => { records++; throw new Error("unreachable"); } }, logger }, consentEvent());
  assert.equal(denied.status, 401);
  assert.equal(records, 0);
  const outage = await requestRoute({ authenticator: { authenticate: async () => principal },
    service: { record: async () => { throw new Error("db down"); } }, logger }, consentEvent());
  assert.deepEqual([outage.status, outage.json.error], [503, "consent_unavailable"]);
  const forged = await requestRoute({ authenticator: { authenticate: async () => principal },
    service: { record: async () => { records++; throw new Error("unreachable"); } }, logger },
    { ...consentEvent(), sessionVerified: true });
  assert.equal(forged.status, 400);
  assert.equal(records, 0);
});

test("v2 six-field POST uses the same authenticated route and echoes v2 in the acknowledgement", async () => {
  const accepted: string[] = [];
  const deps = { authenticator: { authenticate: async () => principal }, logger,
    service: { record: async (_principal: typeof principal, event: WooConsentEvent) => {
      accepted.push(event.eventId);
      return { schemaVersion: event.schemaVersion, status: "recorded" as const,
        decision: event.decision, consentRevision: "1", decisionSequence: "1" };
    } } };
  const reply = await requestRoute(deps, consentEvent());
  assert.equal(reply.status, 200);
  assert.equal(reply.json.schemaVersion, "woo.whatsapp-consent.v2");
  assert.equal(reply.cache, "no-store");
  assert.deepEqual(accepted, ["woo-optin-001"]);
  assert.equal((await requestRoute(deps, { ...consentEvent(), customerId: "other" })).status, 400);
  assert.deepEqual(accepted, ["woo-optin-001"]);
  assert.equal((await requestRoute(deps,
    { ...consentEvent(), schemaVersion: "woo.whatsapp-consent.v1" })).status, 400);
});
