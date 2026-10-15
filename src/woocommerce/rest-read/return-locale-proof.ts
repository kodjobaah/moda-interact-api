import {
  decryptCredential,
  encryptCredential,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import {
  resolveModaConfigurationLocale,
  type ModaSupportedLanguageTag,
  MODA_SUPPORTED_LANGUAGE_TAGS,
} from "@modainteract/moda-interact-shared/internationalization";
import type { WooRestReadAuthorizationConfig } from "./config.js";

const PURPOSE = "moda-woo-read-return-locale-v2";
const SUPPORTED = new Set<string>(MODA_SUPPORTED_LANGUAGE_TAGS);
const PROOF_VERSION = "v2";
const MAX_PROOF_LENGTH = 160;

/** Presentation-only admin language, supplied by WordPress during an authenticated start. */
export function preferredWooAdminLocale(value: string | undefined): ModaSupportedLanguageTag | null {
  if (!value || Buffer.byteLength(value, "utf8") > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const canonical = new Intl.Locale(value.replaceAll("_", "-"));
    const resolved = resolveModaConfigurationLocale(canonical.toString());
    return resolved !== "en" || canonical.language === "en" ? resolved : null;
  } catch {
    return null;
  }
}

function proofAad(attemptId: string, shopId: string, locale: string): string {
  return JSON.stringify([PURPOSE, attemptId, shopId, locale]);
}

/** Authenticate presentation-only locale without exposing AES keys outside Shared. */
export function signWooReturnLocale(
  config: Pick<WooRestReadAuthorizationConfig, "keyring" | "activeKeyId">,
  attemptId: string,
  shopId: string,
  locale: ModaSupportedLanguageTag,
): string {
  const result = encryptCredential({
    keyring: config.keyring, activeKeyId: config.activeKeyId,
    plaintext: locale, aad: proofAad(attemptId, shopId, locale),
  });
  return [PROOF_VERSION, result.keyId,
    Buffer.from(result.nonce).toString("base64url"),
    Buffer.from(result.ciphertext).toString("base64url"),
    Buffer.from(result.authTag).toString("base64url"),
  ].join(".");
}

function decodeCanonical(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
}

/** Ignore untrusted browser parameters unless authenticated against this attempt/shop. */
export function verifyWooReturnLocale(
  config: Pick<WooRestReadAuthorizationConfig, "keyring">,
  attemptId: string,
  shopId: string,
  locale: string | null,
  signature: string | null,
): ModaSupportedLanguageTag | null {
  if (!locale || !SUPPORTED.has(locale) || !signature || signature.length > MAX_PROOF_LENGTH) return null;
  const parts = signature.split(".");
  if (parts.length !== 5 || parts[0] !== PROOF_VERSION ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(parts[1]!) ||
    !/^[A-Za-z0-9_-]{16}$/.test(parts[2]!) ||
    !/^[A-Za-z0-9_-]{2,32}$/.test(parts[3]!) ||
    !/^[A-Za-z0-9_-]{22}$/.test(parts[4]!)) return null;
  const nonce = decodeCanonical(parts[2]!);
  const ciphertext = decodeCanonical(parts[3]!);
  const authTag = decodeCanonical(parts[4]!);
  if (!nonce || nonce.length !== 12 || !ciphertext || !authTag || authTag.length !== 16) return null;
  try {
    const plaintext = decryptCredential({
      keyring: config.keyring,
      envelope: { keyId: parts[1]!, nonce, ciphertext, authTag },
      aad: proofAad(attemptId, shopId, locale),
    });
    return plaintext === locale ? locale as ModaSupportedLanguageTag : null;
  } catch {
    return null;
  }
}
