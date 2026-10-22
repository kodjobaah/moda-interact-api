import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { createWooRecoverySelectionRoute } from "../../../../src/woocommerce/recovery-selection/routes.js";
import { WOO_RECOVERY_SELECTION_PATH, WOO_RECOVERY_SELECTION_VERSION,
  type WooRecoverySelectionStatus } from "../../../../src/woocommerce/recovery-selection/contract.js";

const principal = { shopId: "woo-shop-1", installationId: "woo-install-1",
  canonicalSiteUrl: "https://shop.example", credentialVersion: 1 };
const logger = { info() {}, warn() {}, error() {} } as never;
const status: WooRecoverySelectionStatus = {
  schemaVersion: WOO_RECOVERY_SELECTION_VERSION, consentDecision: "GRANTED", suppressed: false,
  suppressionReason: null, noContactRevision: "0", phoneEligibleForRecovery: true, canReenable: false,
};
const admin = { "x-moda-wp-admin-verified": "1" };
const base = { schemaVersion: WOO_RECOVERY_SELECTION_VERSION, canonicalPhone: "447400123467",
  action: "SUPPRESS", expectedNoContactRevision: "0", evidenceReference: null };

type Setup = Parameters<typeof createWooRecoverySelectionRoute>[0];
async function exercise(options: Setup, method: "GET" | "POST", headers: Record<string, string>, body?: string,
  suffix = "") {
  const route = createWooRecoverySelectionRoute(options);
  const server = createServer((req, res) => { void route.handle(req, res).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await fetch(`${origin}${WOO_RECOVERY_SELECTION_PATH}${suffix}`, {
      method, headers, ...(body !== undefined ? { body } : {}),
    });
    return { status: result.status, json: await result.json() as Record<string, unknown>,
      cache: result.headers.get("cache-control") };
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("a browser without an installation principal or verified admin proxy cannot change a phone", async () => {
  let writes = 0;
  const deps = { authenticator: { authenticate: async () => principal },
    service: { read: async () => status, change: async () => { writes++; return { ...status, outcome: "updated" as const }; } }, logger };
  const request = JSON.stringify(base);
  assert.equal((await exercise({ ...deps, authenticator: { authenticate: async () => { throw new WooUnauthenticatedError(); } } },
    "POST", { "content-type": "application/json", ...admin }, request)).status, 401);
  for (const headers of [{ "content-type": "application/json" },
    { "content-type": "application/json", "x-moda-wp-admin-verified": "0" },
    { "content-type": "application/json", "x-moda-wp-admin-verified": "true" }]) {
    assert.deepEqual((await exercise(deps, "POST", headers, request)).json,
      { error: "admin_authorization_required" });
  }
  assert.equal(writes, 0);
  assert.equal((await exercise(deps, "GET", {}, undefined, "?canonicalPhone=447400123467")).status, 403);
  const wrote = await exercise(deps, "POST", { "content-type": "application/json", ...admin }, request);
  assert.equal(wrote.status, 200);
  assert.equal(wrote.cache, "no-store");
  assert.equal(writes, 1);
});

test("only strict scoped phone queries and bounded versioned commands reach the service", async () => {
  let reads = 0, writes = 0;
  const deps = { authenticator: { authenticate: async () => principal }, logger,
    service: { read: async () => { reads++; return status; }, change: async () => { writes++; return { ...status, outcome: "updated" as const }; } } };
  for (const query of ["", "?canonicalPhone=447400123467&canonicalPhone=447400123467",
    "?canonicalPhone=+447400123467", "?canonicalPhone=447400123467&shopId=shop-other"] ) {
    assert.equal((await exercise(deps, "GET", admin, undefined, query)).status, 400);
  }
  const got = await exercise(deps, "GET", admin, undefined, "?canonicalPhone=447400123467");
  assert.equal(got.status, 200);
  assert.equal(JSON.stringify(got.json).includes("447400123467"), false);
  assert.equal(reads, 1);
  for (const input of [{ ...base, shopId: "other" }, { ...base, action: "RECORD_CUSTOMER_STOP" },
    { ...base, expectedNoContactRevision: "-1" }, { ...base, action: "GRANT" }]) {
    assert.equal((await exercise(deps, "POST", { "content-type": "application/json", ...admin }, JSON.stringify(input))).status, 400);
  }
  assert.equal((await exercise(deps, "POST", { "content-type": "application/json", ...admin },
    '{"schemaVersion":"woo.customer-recovery-selection.v1","canonicalPhone":"447400123467","action":"SUPPRESS","action":"REENABLE","expectedNoContactRevision":"0","evidenceReference":null}')).status, 400);
  assert.equal(writes, 0);
});
