import { createHmac, timingSafeEqual } from "node:crypto";
import {
  resolveModaConfigurationLocale,
  type ModaSupportedLanguageTag,
  MODA_SUPPORTED_LANGUAGE_TAGS,
} from "@modainteract/moda-interact-shared/internationalization";
import type { WooRestReadAuthorizationConfig } from "./config.js";

const PURPOSE = "moda-woo-read-return-locale-v1";
const SUPPORTED = new Set<string>(MODA_SUPPORTED_LANGUAGE_TAGS);

/** Presentation-only admin language, supplied by WordPress during an authenticated start. */
export function preferredWooAdminLocale(value: string | undefined): ModaSupportedLanguageTag | null {
  if (!value || Buffer.byteLength(value, "utf8") > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const canonical = new Intl.Locale(value.replaceAll("_", "-"));
    const resolved = resolveModaConfigurationLocale(canonical.toString());
    // The shared resolver also returns English for unsupported languages;
    // do not override a supported shop language with that fallback.
    return resolved !== "en" || canonical.language === "en" ? resolved : null;
  } catch {
    return null;
  }
}

/** Domain-separated MAC key, never derived from the browser-visible callback bearer. */
function proofForKey(key: Buffer, attemptId: string, shopId: string, locale: string): Buffer {
  const proofKey = createHmac("sha256", key).update(`${PURPOSE}-key`).digest();
  return createHmac("sha256", proofKey)
    .update(`${PURPOSE}\0${attemptId}\0${shopId}\0${locale}`)
    .digest();
}

/** Bind the UI locale to this already-persisted attempt, without a schema migration. */
export function signWooReturnLocale(
  config: Pick<WooRestReadAuthorizationConfig, "keys" | "activeKeyId">,
  attemptId: string,
  shopId: string,
  locale: ModaSupportedLanguageTag,
): string {
  const key = config.keys.get(config.activeKeyId);
  if (!key || key.length !== 32) throw new TypeError("Invalid return signing key");
  return proofForKey(key, attemptId, shopId, locale).toString("base64url");
}

/** Ignore untrusted browser parameters unless they verify against this shop's attempt. */
export function verifyWooReturnLocale(
  config: Pick<WooRestReadAuthorizationConfig, "keys">,
  attemptId: string,
  shopId: string,
  locale: string | null,
  signature: string | null,
): ModaSupportedLanguageTag | null {
  if (!locale || !SUPPORTED.has(locale) || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  const submitted = Buffer.from(signature, "base64url");
  if (submitted.length !== 32 || submitted.toString("base64url") !== signature) return null;
  let verified = false;
  for (const key of config.keys.values()) {
    if (key.length === 32) {
      verified = timingSafeEqual(submitted, proofForKey(key, attemptId, shopId, locale)) || verified;
    }
  }
  return verified ? locale as ModaSupportedLanguageTag : null;
}
