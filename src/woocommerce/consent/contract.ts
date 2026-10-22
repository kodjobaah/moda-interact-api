/** API-owned PHP -> hosted-API contract. It is never an indication of checkout recovery eligibility. */
export const WOO_CONSENT_PATH = "/v1/woocommerce/whatsapp-consent";
export const WOO_CONSENT_VERSION = "woo.whatsapp-consent.v1";
export const WOO_CONSENT_DISCLOSURE = "moda.woo.whatsapp-recovery-marketing.v1";
export const WOO_CONSENT_FIELD = "moda/whatsapp-checkout-recovery";
export const MAX_WOO_CONSENT_BYTES = 8192;
export type WooConsentDecision = "GRANT" | "REVOKE";

/** Assertions supplied by the *authenticated PHP plugin*, not by storefront JavaScript.
 * WOOCOMMERCE-002 must mint these values only after validating a live Classic
 * nonce or Blocks Store API nonce/cart token, Woo session, server-observed field
 * transition and server-observed billing contact. The hosted API cannot inspect
 * WordPress session state or validate a WordPress nonce on its own.
 */
export interface VerifiedWooCheckoutAction {
  checkoutKey: string;
  checkoutMode: "CLASSIC" | "BLOCKS";
  source: "WOO_CHECKOUT_SERVER_HOOK";
  fieldId: typeof WOO_CONSENT_FIELD;
  selection: "CHECKED" | "UNCHECKED";
  userInitiated: true;
  nonceVerified: true;
  sessionVerified: true;
  serverObservedPhone: string;
  verifiedCountryCode: string | null;
  occurredAt: string;
}

export interface WooConsentDisclosure {
  version: typeof WOO_CONSENT_DISCLOSURE;
  locale: string;
  /** Exact text rendered to the customer, including this merchant's canonical URL. */
  text: string;
  merchantSiteUrl: string;
}

export interface WooConsentEvent {
  schemaVersion: typeof WOO_CONSENT_VERSION;
  eventId: string;
  decision: WooConsentDecision;
  purpose: "WHATSAPP_CHECKOUT_RECOVERY";
  /** Digits-only E.164, independently checked against serverObservedPhone. */
  canonicalPhone: string;
  checkoutAction: VerifiedWooCheckoutAction;
  disclosure: WooConsentDisclosure | null;
}

export interface WooConsentResult {
  schemaVersion: typeof WOO_CONSENT_VERSION;
  status: "recorded" | "duplicate";
  decision: WooConsentDecision;
  /** Decimal strings because PostgreSQL uses BIGINT, not JavaScript numbers. */
  consentRevision: string;
  decisionSequence: string;
}

export class WooConsentHttpError extends Error {
  constructor(readonly status: 400 | 409 | 413 | 422 | 503,
    readonly code: string) { super(code); }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(v) || Object.keys(v).length !== keys.length ||
    Object.keys(v).some(key => !keys.includes(key))) throw invalid();
  return v;
}
function invalid(): WooConsentHttpError { return new WooConsentHttpError(400, "invalid_request"); }
// Preserve the exact C0/DEL rejection set without embedding forbidden control
// characters in a regex. Horizontal tab, line feed and carriage return were
// deliberately allowed by the existing contract.
function hasForbiddenControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}
function str(v: unknown, max: number, pattern?: RegExp): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max ||
    hasForbiddenControl(v) || (pattern && !pattern.test(v))) throw invalid();
  return v;
}
function timestamp(v: unknown): string {
  const value = str(v, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid();
  return value;
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
const canonical = /^[1-9][0-9]{1,14}$/;

export function parseWooConsentEvent(value: unknown): WooConsentEvent {
  const input = exact(value, ["schemaVersion", "eventId", "decision", "purpose", "canonicalPhone", "checkoutAction", "disclosure"]);
  if (input.schemaVersion !== WOO_CONSENT_VERSION ||
    !["GRANT", "REVOKE"].includes(String(input.decision)) ||
    input.purpose !== "WHATSAPP_CHECKOUT_RECOVERY") throw invalid();
  const action = exact(input.checkoutAction, ["checkoutKey", "checkoutMode", "source", "fieldId",
    "selection", "userInitiated", "nonceVerified", "sessionVerified", "serverObservedPhone",
    "verifiedCountryCode", "occurredAt"]);
  const decision = input.decision as WooConsentDecision;
  if (!["CLASSIC", "BLOCKS"].includes(String(action.checkoutMode)) ||
    action.source !== "WOO_CHECKOUT_SERVER_HOOK" || action.fieldId !== WOO_CONSENT_FIELD ||
    action.userInitiated !== true || action.nonceVerified !== true || action.sessionVerified !== true ||
    action.selection !== (decision === "GRANT" ? "CHECKED" : "UNCHECKED")) throw invalid();
  const country = action.verifiedCountryCode;
  if (country !== null && (typeof country !== "string" || !/^[A-Z]{2}$/.test(country))) throw invalid();
  const rawDisclosure = input.disclosure;
  let disclosure: WooConsentDisclosure | null = null;
  if (rawDisclosure !== null) {
    const d = exact(rawDisclosure, ["version", "locale", "text", "merchantSiteUrl"]);
    if (d.version !== WOO_CONSENT_DISCLOSURE) throw invalid();
    const locale = str(d.locale, 64, /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{2,8}){0,4}$/);
    try { Intl.getCanonicalLocales(locale); } catch { throw invalid(); }
    disclosure = { version: WOO_CONSENT_DISCLOSURE, locale,
      text: str(d.text, 4000), merchantSiteUrl: str(d.merchantSiteUrl, 512) };
  }
  if (decision === "GRANT" && disclosure === null) throw invalid();
  return {
    schemaVersion: WOO_CONSENT_VERSION,
    eventId: str(input.eventId, 128, identifier),
    decision,
    purpose: "WHATSAPP_CHECKOUT_RECOVERY",
    canonicalPhone: str(input.canonicalPhone, 15, canonical),
    checkoutAction: {
      checkoutKey: str(action.checkoutKey, 128, identifier),
      checkoutMode: action.checkoutMode as "CLASSIC" | "BLOCKS",
      source: "WOO_CHECKOUT_SERVER_HOOK", fieldId: WOO_CONSENT_FIELD,
      selection: decision === "GRANT" ? "CHECKED" : "UNCHECKED",
      userInitiated: true, nonceVerified: true, sessionVerified: true,
      serverObservedPhone: str(action.serverObservedPhone, 64),
      verifiedCountryCode: country as string | null,
      occurredAt: timestamp(action.occurredAt),
    },
    disclosure,
  };
}
