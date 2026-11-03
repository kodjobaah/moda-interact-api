import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createWooConsentStatusRoute } from "../../../../src/woocommerce/consent-status/routes.js";
import { WOO_CONSENT_STATUS_PATH, WOO_CONSENT_STATUS_VERSION } from
  "../../../../src/woocommerce/consent-status/contract.js";

const grant = { schemaVersion: WOO_CONSENT_STATUS_VERSION,
  canonicalPhone: "447400123456", grantEventId: "contract-grant-01" };

async function actualApiResponse(state: "CONFIRMED_GRANTED" | "UNVERIFIED" | "error") {
  const route = createWooConsentStatusRoute({
    authenticator: { authenticate: async () => ({ shopId: "contract-shop", installationId: "contract-installation",
      credentialVersion: 1, canonicalSiteUrl: "http://localhost:8888" }) },
    service: { read: async () => {
      if (state === "error") throw Object.assign(new Error("provider offline"), { code: "P1001" });
      return { schemaVersion: WOO_CONSENT_STATUS_VERSION, state };
    } },
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  const server = createServer((request, response) => {
    void route.handle(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${WOO_CONSENT_STATUS_PATH}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(grant) });
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { httpStatus: response.status, body: await response.text() };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("actual API response is accepted by the actual Woo PHP ModaApiClient", async () => {
  const wooRoot = process.env.MODA_WOO_SOURCE_ROOT;
  assert.ok(wooRoot, "Set MODA_WOO_SOURCE_ROOT to the dedicated WooCommerce implementation checkout");
  const confirmed = await actualApiResponse("CONFIRMED_GRANTED");
  const unverified = await actualApiResponse("UNVERIFIED");
  const unavailable = await actualApiResponse("error");
  const fixture = fileURLToPath(new URL("../../../contracts/woocommerce/consent-status-php-client.php", import.meta.url));
  const result = spawnSync("php", [fixture], {
    encoding: "utf8", env: { ...process.env, MODA_WOO_SOURCE_ROOT: wooRoot },
    input: JSON.stringify({ cases: [
      { ...confirmed, expectedState: "CONFIRMED_GRANTED" },
      { ...unverified, expectedState: "UNVERIFIED" },
      { ...unavailable, expectedError: "remote_unavailable" },
      { ...confirmed, body: JSON.stringify({ schemaVersion: WOO_CONSENT_STATUS_VERSION,
        state: "CONFIRMED_GRANTED", extra: "not-allowed" }), expectedError: "remote_response_invalid" },
    ] }),
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /4 cases/);
});
