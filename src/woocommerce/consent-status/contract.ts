import { normalizeRecipientPhone } from "@modainteract/moda-interact-shared/identity";

/** Read-only Woo checkout status. The browser never supplies a customer or shop identity. */
export const WOO_CONSENT_STATUS_PATH = "/v1/woocommerce/whatsapp-consent/status";
export const WOO_CONSENT_STATUS_VERSION = "woo.whatsapp-consent-status.v1";
export const MAX_WOO_CONSENT_STATUS_BYTES = 512;

export interface WooConsentStatusProbe {
  schemaVersion: typeof WOO_CONSENT_STATUS_VERSION;
  canonicalPhone: string;
  grantEventId: string;
}

export interface WooConsentStatusResult {
  schemaVersion: typeof WOO_CONSENT_STATUS_VERSION;
  state: "CONFIRMED_GRANTED" | "UNVERIFIED";
}

export class WooConsentStatusHttpError extends Error {
  constructor(readonly status: 400 | 413, readonly code: "invalid_request" | "request_too_large") {
    super(code);
    this.name = "WooConsentStatusHttpError";
  }
}

const invalid = (): WooConsentStatusHttpError => new WooConsentStatusHttpError(400, "invalid_request");
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
const PHONE = /^[1-9][0-9]{1,14}$/;
const KEYS = ["schemaVersion", "canonicalPhone", "grantEventId"];

/** Never accept phone-only authority or inferred identity from extra request keys. */
export function parseWooConsentStatusProbe(input: unknown): WooConsentStatusProbe {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).length !== KEYS.length ||
    Object.keys(body).some(key => !KEYS.includes(key)) ||
    body.schemaVersion !== WOO_CONSENT_STATUS_VERSION ||
    typeof body.canonicalPhone !== "string" || !PHONE.test(body.canonicalPhone) ||
    typeof body.grantEventId !== "string" || !IDENTIFIER.test(body.grantEventId)) throw invalid();
  const normalized = normalizeRecipientPhone(`+${body.canonicalPhone}`);
  if (!normalized.ok || normalized.e164.slice(1) !== body.canonicalPhone) throw invalid();
  return { schemaVersion: WOO_CONSENT_STATUS_VERSION,
    canonicalPhone: body.canonicalPhone, grantEventId: body.grantEventId };
}
