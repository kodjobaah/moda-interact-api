import { createHmac, randomBytes } from "node:crypto";
import type { CanonicalWooSite } from "../installation/site-url.js";
import type { WooRestReadCredential } from "./envelope.js";

/** RFC 3986 percent encoding (encodeURIComponent alone leaves !'()* unescaped). */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * WooCommerce's one-legged OAuth 1.0a signature for HTTP **local development**.
 * The consumer secret is only the HMAC signing key: it never goes on the wire.
 * Each GET must have a fresh nonce, including a later grant-verification read.
 *
 * Caller MUST enforce local-development mode, approved local-only DNS and the
 * fixed GET-only WooCommerce product path before using this helper.
 */
export function signLocalWooReadPath(
  site: CanonicalWooSite,
  path: string,
  credential: WooRestReadCredential,
  testValues?: { nonce: string; timestamp: number },
): string {
  if (site.protocol !== "http:" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error("local_oauth_invalid_target");
  }
  const url = new URL(path, site.canonicalSiteUrl);
  if (url.origin !== new URL(site.canonicalSiteUrl).origin || url.hash || url.username || url.password) {
    throw new Error("local_oauth_invalid_target");
  }
  const nonce = testValues?.nonce ?? randomBytes(16).toString("hex");
  const timestamp = testValues?.timestamp ?? Math.floor(Date.now() / 1000);
  if (!/^[A-Za-z0-9]{32}$/.test(nonce) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error("local_oauth_invalid_parameters");
  }
  const existing = [...url.searchParams];
  if (existing.some(([key]) => key.startsWith("oauth_") || key === "consumer_secret" || key === "consumer_key") ||
    new Set(existing.map(([key]) => key)).size !== existing.length) {
    throw new Error("local_oauth_invalid_parameters");
  }
  const parameters: Array<[string, string]> = [
    ...existing,
    ["oauth_consumer_key", credential.consumerKey],
    ["oauth_nonce", nonce],
    ["oauth_signature_method", "HMAC-SHA256"],
    ["oauth_timestamp", String(timestamp)],
  ];
  // WooCommerce's signature verifier percent-encodes each key/value, sorts by
  // parameter name, then percent-encodes the entire normalized pair. No oauth_version.
  parameters.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const normalized = parameters.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const base = `GET&${encode(`${url.origin}${url.pathname}`)}&${encode(normalized)}`;
  const signature = createHmac("sha256", `${credential.consumerSecret}&`).update(base).digest("base64");
  for (const [key, value] of parameters) url.searchParams.set(key, value);
  url.searchParams.set("oauth_signature", signature);
  return `${url.pathname}${url.search}`;
}
