import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWooConsentRoute } from "../../../../src/woocommerce/consent/routes.js";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";
import { WOO_CONSENT_PATH } from "../../../../src/woocommerce/consent/contract.js";

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
      return { schemaVersion: "woo.whatsapp-consent.v1" as const, status: "recorded" as const,
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

test("revoked credentials, DB outage and invalid guest attestations fail closed", async () => {
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
    consentEvent({ checkoutAction: { ...consentEvent().checkoutAction, sessionVerified: false as true } }));
  assert.equal(forged.status, 400);
  assert.equal(records, 0);
});

// This verifies the hosted API's rejection of false/malformed *server attestations*.
// Whether a real Classic/Blocks Woo hook correctly verifies a customer nonce,
// cart/session transition or login/logout is a WOOCOMMERCE-002/003 producer test.
test("both Classic and Blocks reject forged guest checkout CSRF/session assertions", async () => {
  let records = 0;
  const deps = { authenticator: { authenticate: async () => principal }, logger,
    service: { record: async () => { records++;
      return { schemaVersion: "woo.whatsapp-consent.v1" as const, status: "recorded" as const,
        decision: "GRANT" as const, consentRevision: "1", decisionSequence: "1" }; } } };
  for (const checkoutMode of ["CLASSIC", "BLOCKS"] as const) {
    const valid = consentEvent({ checkoutAction: { ...consentEvent().checkoutAction, checkoutMode } });
    const forged: unknown[] = [
      { ...valid, checkoutAction: { ...valid.checkoutAction, nonceVerified: false } },
      { ...valid, checkoutAction: { ...valid.checkoutAction, sessionVerified: false } },
      { ...valid, checkoutAction: { ...valid.checkoutAction, userInitiated: false } },
      { ...valid, checkoutAction: { ...valid.checkoutAction, source: "STOREFRONT_JS" } },
      { ...valid, checkoutAction: { ...valid.checkoutAction, selection: "UNCHECKED" } },
      { ...valid, checkoutAction: { ...valid.checkoutAction, nonceVerified: "true" } },
      { ...valid, checkoutAction: { ...valid.checkoutAction, sessionVerified: "true" } },
      { ...valid, checkoutAction: { ...valid.checkoutAction, customerId: "forged" } },
      { ...valid, visitorId: "browser-supplied-guest" },
    ];
    for (const invalid of forged) {
      const rejected = await requestRoute(deps, invalid);
      assert.equal(rejected.status, 400, `invalid ${checkoutMode} checkout attestation must be rejected`);
    }
    assert.equal(records, 0, `no forged ${checkoutMode} event can reach the consent service`);
    const admitted = await requestRoute(deps, valid);
    assert.equal(admitted.status, 200, `verified ${checkoutMode} server assertions reach the service`);
  }
  assert.equal(records, 2);
});
