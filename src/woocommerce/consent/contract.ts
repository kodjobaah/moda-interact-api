/** Authenticated Woo server -> hosted API consent-write contract; never recovery eligibility. */
export const WOO_CONSENT_PATH = "/v1/woocommerce/whatsapp-consent";
export const WOO_CONSENT_VERSION = "woo.whatsapp-consent.v2";
/** Disclosure revisions are independent of the v2 transport version. */
export const WOO_CONSENT_DISCLOSURE = "moda.woo.whatsapp-recovery-marketing.v3";
export const MAX_WOO_CONSENT_BYTES = 8192;
export type WooConsentDecision = "GRANT" | "REVOKE";

/** Exact consent wording and revision as shown by the WooCommerce plugin. */
export interface WooConsentDisclosure {
  version: string;
  locale: string;
  text: string;
}

/** A purpose- and merchant-scoped consent assertion from the authenticated Woo server.
 * The hosted API does not reconstruct Classic/Blocks checkout session facts.
 */
export interface WooConsentEvent {
  schemaVersion: typeof WOO_CONSENT_VERSION;
  eventId: string;
  decision: WooConsentDecision;
  canonicalPhone: string;
  occurredAt: string;
  disclosure: WooConsentDisclosure | null;
}

export interface WooConsentResult {
  schemaVersion: WooConsentEvent["schemaVersion"];
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
  const input = exact(value, ["schemaVersion", "eventId", "decision", "canonicalPhone", "occurredAt", "disclosure"]);
  if (input.schemaVersion !== WOO_CONSENT_VERSION ||
    (input.decision !== "GRANT" && input.decision !== "REVOKE")) throw invalid();
  const decision = input.decision as WooConsentDecision;
  let disclosure: WooConsentEvent["disclosure"] = null;
  if (decision === "GRANT") {
    const d = exact(input.disclosure, ["version", "locale", "text"]);
    const version = str(d.version, 128,
      /^moda\.woo\.whatsapp-recovery-marketing\.v[1-9][0-9]*$/);
    const locale = str(d.locale, 64, /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{2,8}){0,4}$/);
    try { Intl.getCanonicalLocales(locale); } catch { throw invalid(); }
    disclosure = { version, locale, text: str(d.text, 4000) };
  } else if (input.disclosure !== null) {
    throw invalid();
  }
  return {
    schemaVersion: WOO_CONSENT_VERSION,
    eventId: str(input.eventId, 128, identifier),
    decision,
    canonicalPhone: str(input.canonicalPhone, 15, canonical),
    occurredAt: timestamp(input.occurredAt),
    disclosure,
  };
}
