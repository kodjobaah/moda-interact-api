import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeWooSiteUrl } from "../installation/site-url.js";
import { signLocalWooReadPath } from "./local-http-oauth.js";

const nonce = "0123456789abcdef0123456789abcdef";
const timestamp = 1791648000;
const credentials = { consumerKey: "ck_abc123", consumerSecret: "cs_verysecret" };

test("WooCommerce HTTP OAuth 1.0a signs all GET query parameters against the canonical store URL", () => {
  const site = canonicalizeWooSiteUrl("http://woocommerce-sandbox.local", "local-development");
  const signed = signLocalWooReadPath(site, "/wp-json/wc/v3/products?per_page=1&_fields=id", credentials,
    { nonce, timestamp });
  const url = new URL(signed, "http://woocommerce-sandbox.local");
  assert.equal(url.pathname, "/wp-json/wc/v3/products");
  assert.equal(url.searchParams.get("oauth_consumer_key"), "ck_abc123");
  assert.equal(url.searchParams.get("oauth_nonce"), nonce);
  assert.equal(url.searchParams.get("oauth_timestamp"), String(timestamp));
  assert.equal(url.searchParams.get("oauth_signature_method"), "HMAC-SHA256");
  // Independently calculated RFC 3986 normalization / HMAC-SHA256 vector.
  assert.equal(url.searchParams.get("oauth_signature"), "qEk0J/1Dqltac4YBqHCQ680DzdnyskATL9PAw9Uev38=");
  assert.equal(url.searchParams.has("oauth_version"), false);
  assert.equal(signed.includes(credentials.consumerSecret), false);
  assert.equal(signed.includes("consumer_secret"), false);
  assert.equal(signed.includes("Basic"), false);
  const reordered = signLocalWooReadPath(site, "/wp-json/wc/v3/products?_fields=id&per_page=1", credentials,
    { nonce, timestamp });
  assert.equal(new URL(reordered, site.canonicalSiteUrl).searchParams.get("oauth_signature"),
    url.searchParams.get("oauth_signature"));
});

test("OAuth binds the shop origin, subdirectory, query and nonce without exposing the secret", () => {
  const site = canonicalizeWooSiteUrl("http://localhost:55433/shop", "local-development");
  const path = "/shop/wp-json/wc/v3/products?context=view&search=%E5%B8%BD%E5%AD%90";
  const signed = signLocalWooReadPath(site, path, credentials, { nonce, timestamp });
  const url = new URL(signed, site.canonicalSiteUrl);
  assert.equal(url.pathname, "/shop/wp-json/wc/v3/products");
  assert.equal(url.searchParams.get("search"), "帽子");
  assert.equal(url.searchParams.get("context"), "view");
  assert.equal(url.searchParams.has("oauth_version"), false);
  assert.equal(signed.includes(credentials.consumerSecret), false);
  const differentNonce = signLocalWooReadPath(site, path, credentials,
    { nonce: "abcdef0123456789abcdef0123456789", timestamp });
  assert.notEqual(new URL(differentNonce, site.canonicalSiteUrl).searchParams.get("oauth_signature"),
    url.searchParams.get("oauth_signature"));
  const anotherHost = canonicalizeWooSiteUrl("http://another.local:55433/shop", "local-development");
  assert.notEqual(new URL(signLocalWooReadPath(anotherHost, path, credentials, { nonce, timestamp }),
    anotherHost.canonicalSiteUrl).searchParams.get("oauth_signature"), url.searchParams.get("oauth_signature"));
});

test("Local HTTP OAuth helper rejects invalid target paths and reserved parameters", () => {
  const site = canonicalizeWooSiteUrl("http://localhost:55433", "local-development");
  for (const badPath of ["//evil.test/wp-json/wc/v3/products", "/wp-json/wc/v3/products?oauth_nonce=forged",
    "/wp-json/wc/v3/products?consumer_secret=leak", "/wp-json/wc/v3/products?per_page=1&per_page=2"]) {
    assert.throws(() => signLocalWooReadPath(site, badPath, credentials, { nonce, timestamp }));
  }
  assert.throws(() => signLocalWooReadPath(canonicalizeWooSiteUrl("https://example.org", "public"),
    "/wp-json/wc/v3/products", credentials, { nonce, timestamp }));
});
