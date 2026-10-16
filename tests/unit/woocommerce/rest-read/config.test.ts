import assert from "node:assert/strict";
import test from "node:test";
import {
  loadWooRestReadAuthorizationConfig,
} from "../../../../src/woocommerce/rest-read/config.js";

const canonical = {
  MODA_WOO_REST_READ_PUBLIC_ORIGIN: "https://api.example.org",
  COMMERCE_CONNECTION_ACTIVE_KEY_ID: "v1",
  COMMERCE_CONNECTION_KEYS_JSON: JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64") }),
};

test("disabled by default, legacy-only keyring cannot activate the API", () => {
  assert.equal(loadWooRestReadAuthorizationConfig({}, "public"), null);
  assert.equal(loadWooRestReadAuthorizationConfig({
    MODA_WOO_REST_READ_ACTIVE_KEY_ID: "v1",
    MODA_WOO_REST_READ_KEYRING: JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64url") }),
  }, "public"), null);
  assert.throws(() => loadWooRestReadAuthorizationConfig({
    ...canonical,
    COMMERCE_CONNECTION_KEYS_JSON: undefined,
    MODA_WOO_REST_READ_KEYRING: JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64url") }),
  }, "public"), /incomplete/);
});

test("canonical configuration uses strict Shared parser and active selector", () => {
  const result = loadWooRestReadAuthorizationConfig(canonical, "public");
  assert.ok(result);
  assert.equal(result.activeKeyId, "v1");
  assert.deepEqual(result.keyring.keyIds, ["v1"]);
  assert.equal(result.keyring.hasKey("v1"), true);
  assert.equal("keys" in result, false, "raw AES key adapter must not be exposed");
  assert.equal(result.publicOrigin, "https://api.example.org");
});

test("invalid canonical configuration fails closed without exposing key material", () => {
  const validKey = Buffer.alloc(32, 7).toString("base64");
  const malformed = [
    { ...canonical, COMMERCE_CONNECTION_KEYS_JSON: undefined },
    { ...canonical, COMMERCE_CONNECTION_ACTIVE_KEY_ID: undefined },
    { ...canonical, COMMERCE_CONNECTION_ACTIVE_KEY_ID: "missing" },
    { ...canonical, COMMERCE_CONNECTION_ACTIVE_KEY_ID: " v1 " },
    { ...canonical, COMMERCE_CONNECTION_KEYS_JSON: JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64url") }) },
    { ...canonical, COMMERCE_CONNECTION_KEYS_JSON: JSON.stringify({ v1: "too-short" }) },
    { ...canonical, COMMERCE_CONNECTION_KEYS_JSON: `{"v1":"${validKey}","v1":"${validKey}"}` },
    { ...canonical, COMMERCE_CONNECTION_KEYS_JSON: `{"v1":"${validKey}","\\u00761":"${validKey}"}` },
  ];
  for (const value of malformed) {
    assert.throws(() => loadWooRestReadAuthorizationConfig(value, "public"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(validKey), false);
      return true;
    });
  }
});

test("command-HMAC is never required for API credential operations", () => {
  assert.ok(loadWooRestReadAuthorizationConfig({ ...canonical, COMMERCE_CONNECTION_COMMAND_HMAC_KEY: "not-a-key" }, "public"));
});

test("origin restrictions remain unchanged", () => {
  for (const origin of ["http://api.example.org", "https://localhost", "https://api.example.org:8443", "https://evil.example.org/path"]) {
    assert.throws(() => loadWooRestReadAuthorizationConfig({ ...canonical, MODA_WOO_REST_READ_PUBLIC_ORIGIN: origin }, "public"));
  }
  assert.equal(loadWooRestReadAuthorizationConfig({ ...canonical, MODA_WOO_REST_READ_PUBLIC_ORIGIN: "http://localhost:3100" }, "local-development")?.publicOrigin, "http://localhost:3100");
});
