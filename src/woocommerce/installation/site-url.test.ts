import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeWooSiteUrl } from "./site-url.js";

test("canonicalizes DNS hosts and WordPress base paths", () => {
  assert.equal(
    canonicalizeWooSiteUrl("https://Example.COM/", "public").canonicalSiteUrl,
    "https://example.com",
  );
  assert.equal(
    canonicalizeWooSiteUrl("https://Example.COM/store///", "public").canonicalSiteUrl,
    "https://example.com/store",
  );
  assert.equal(
    canonicalizeWooSiteUrl("https://example.com:443/store", "public").canonicalSiteUrl,
    "https://example.com/store",
  );
});

test("public mode requires HTTPS DNS identities and rejects URL authority extras", () => {
  for (const value of [
    "http://example.com",
    "https://127.0.0.1",
    "https://user:pass@example.com",
    "https://example.com:8443",
    "https://example.com/store?q=1",
    "https://example.com/store#fragment",
  ]) {
    assert.throws(() => canonicalizeWooSiteUrl(value, "public"), /invalid_site_url/);
  }
});

test("local-development canonicalization accepts explicit local HTTP ports", () => {
  assert.equal(
    canonicalizeWooSiteUrl("http://woocommerce-sandbox.local:8080/", "local-development")
      .canonicalSiteUrl,
    "http://woocommerce-sandbox.local:8080",
  );
  assert.equal(
    canonicalizeWooSiteUrl("http://127.0.0.1:8080/", "local-development")
      .canonicalSiteUrl,
    "http://127.0.0.1:8080",
  );
  assert.equal(
    canonicalizeWooSiteUrl("http://[::1]:8080/", "local-development").canonicalSiteUrl,
    "http://[::1]:8080",
  );
  assert.throws(() => canonicalizeWooSiteUrl("https://[::1]", "public"), /invalid_site_url/);
});

test("rejects empty, invalid and overlong canonical site URLs", () => {
  for (const value of ["", "https://", `https://example.com/${"a".repeat(510)}`]) {
    assert.throws(() => canonicalizeWooSiteUrl(value, "public"), /invalid_site_url/);
  }
});