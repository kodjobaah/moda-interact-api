import { isIP } from "node:net";
import type { RuntimeEnvironment } from "../../runtime-config.js";
import type { WooConnectionMode } from "../installation/site-url.js";

export interface WooRestReadAuthorizationConfig {
  publicOrigin: string;
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

/** Never permit partial configuration to enable a credential-accepting endpoint. */
export function loadWooRestReadAuthorizationConfig(
  environment: RuntimeEnvironment,
  connectionMode: WooConnectionMode,
): WooRestReadAuthorizationConfig | null {
  const originValue = environment.MODA_WOO_REST_READ_PUBLIC_ORIGIN?.trim();
  const keyId = environment.MODA_WOO_REST_READ_ACTIVE_KEY_ID?.trim();
  const rawKeyring = environment.MODA_WOO_REST_READ_KEYRING?.trim();
  if (!originValue && !keyId && !rawKeyring) return null;
  if (!originValue || !keyId || !rawKeyring || !/^[A-Za-z0-9_-]{1,128}$/.test(keyId)) {
    throw new Error("Woo REST read authorization configuration is incomplete");
  }
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    throw new Error("Woo REST read authorization origin is invalid");
  }
  const host = origin.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLocalName = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host) !== 0;
  if (
    origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
    (origin.protocol !== "https:" && !(connectionMode === "local-development" && origin.protocol === "http:")) ||
    (connectionMode === "public" && (isLocalName || origin.port !== "")) ||
    (origin.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(host))
  ) {
    throw new Error("Woo REST read authorization origin must be an approved API origin");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawKeyring);
  } catch {
    throw new Error("Woo REST read authorization keyring is invalid");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Woo REST read authorization keyring is invalid");
  }
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error("Woo REST read authorization keyring is invalid");
  }
  const keys = new Map<string, Buffer>();
  for (const [id, encoded] of entries) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof encoded !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
      throw new Error("Woo REST read authorization keyring is invalid");
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== encoded) {
      throw new Error("Woo REST read authorization keyring is invalid");
    }
    keys.set(id, key);
  }
  if (!keys.has(keyId)) throw new Error("Woo REST read authorization active key is unavailable");
  return { publicOrigin: origin.origin, activeKeyId: keyId, keys };
}
