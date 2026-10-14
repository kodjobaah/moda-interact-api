import { isIP } from "node:net";
import {
  parseCredentialKeyring,
  resolveActiveCredentialKey,
  type CredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import type { RuntimeEnvironment } from "../../runtime-config.js";
import type { WooConnectionMode } from "../installation/site-url.js";

export interface WooRestReadAuthorizationConfig {
  publicOrigin: string;
  activeKeyId: string;
  keyring: CredentialKeyring;
  /**
   * Temporary raw-key adapter for the pre-ARCH-039 Woo grant cipher and signed
   * return-locale proof. API-002 must remove this adapter when migrating those
   * consumers; no other code should consume the raw key material.
   */
  keys: ReadonlyMap<string, Buffer>;
}

/** Never permit partial configuration to enable a credential-accepting endpoint. */
export function loadWooRestReadAuthorizationConfig(
  environment: RuntimeEnvironment,
  connectionMode: WooConnectionMode,
): WooRestReadAuthorizationConfig | null {
  const originValue = environment.MODA_WOO_REST_READ_PUBLIC_ORIGIN?.trim();
  // ARCH-039: ONLY these two credential-encryption variables are permitted in API.
  // Do not read Woo-specific aliases or COMMERCE_CONNECTION_COMMAND_HMAC_KEY.
  const activeKeyIdRaw = environment.COMMERCE_CONNECTION_ACTIVE_KEY_ID;
  const rawKeyring = environment.COMMERCE_CONNECTION_KEYS_JSON;
  if (!originValue && !activeKeyIdRaw && !rawKeyring) return null;
  if (!originValue || !activeKeyIdRaw || !rawKeyring) {
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

  let keyring: CredentialKeyring;
  let activeKeyId: string;
  try {
    // Shared owns ALL keyring-format and active-key validation. This rejects
    // duplicate JSON properties, noncanonical Base64 and invalid key IDs.
    keyring = parseCredentialKeyring(rawKeyring);
    activeKeyId = resolveActiveCredentialKey(keyring, activeKeyIdRaw);
  } catch {
    throw new Error("Woo REST read authorization credential configuration is invalid");
  }

  // Bounded compatibility adapter for the still-local Woo grant cipher and
  // return-page HMAC (both consume raw bytes). This input has ALREADY passed
  // strict Shared validation: it is not an alternate parser or config source.
  // API-002 must remove this and migrate both consumers before closing ARCH-039.
  const validated = JSON.parse(rawKeyring) as Record<string, string>;
  const keys = new Map<string, Buffer>(
    keyring.keyIds.map((id) => [id, Buffer.from(validated[id]!, "base64")]),
  );
  return { publicOrigin: origin.origin, activeKeyId, keyring, keys };
}
