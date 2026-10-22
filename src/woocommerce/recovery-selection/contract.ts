import { normalizeRecipientPhone } from "@modainteract/moda-interact-shared/identity";

/** API-005: merchant no-contact control is separate from customer permission. */
export const WOO_RECOVERY_SELECTION_PATH = "/v1/woocommerce/customer-recovery-selection";
export const WOO_RECOVERY_SELECTION_VERSION = "woo.customer-recovery-selection.v1";
export const MAX_WOO_RECOVERY_SELECTION_BYTES = 2048;

export type RecoverySelectionCommand = "SUPPRESS" | "REENABLE" | "RECORD_CUSTOMER_STOP";
export type RecoveryConsentDecision = "UNKNOWN" | "GRANTED" | "REVOKED";
export type RecoveryNoContactReason = "MERCHANT_OPT_OUT" | "CUSTOMER_STOP" | null;

/** No shop/customer ID may be selected by the browser. The installed shop is
 * authoritative; revision is an optimistic concurrency and retry token. */
export interface WooRecoverySelectionChange {
  schemaVersion: typeof WOO_RECOVERY_SELECTION_VERSION;
  canonicalPhone: string;
  action: RecoverySelectionCommand;
  expectedNoContactRevision: string;
  /** Opaque admin-held external evidence reference, required ONLY for off-channel STOP.
   * The current Database schema has no field to retain this reference: never log PII. */
  evidenceReference: string | null;
}

/** Safe for the privileged merchant UI; never return phone/customer identity. */
export interface WooRecoverySelectionStatus {
  schemaVersion: typeof WOO_RECOVERY_SELECTION_VERSION;
  consentDecision: RecoveryConsentDecision;
  suppressed: boolean;
  suppressionReason: RecoveryNoContactReason;
  noContactRevision: string;
  phoneEligibleForRecovery: boolean;
  canReenable: boolean;
}

export type WooRecoverySelectionWriteResult = WooRecoverySelectionStatus & {
  outcome: "updated" | "duplicate";
};

export class WooRecoverySelectionError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413,
    readonly code: string) { super(code); }
}

const invalid = () => new WooRecoverySelectionError(400, "invalid_request");
const canonical = /^[1-9][0-9]{1,14}$/;
const revision = /^(?:0|[1-9][0-9]{0,18})$/;
const ref = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/;
const maxPgBigint = 9223372036854775807n;

export function parseCanonicalPhone(input: unknown): string {
  if (typeof input !== "string" || !canonical.test(input)) throw invalid();
  const normalized = normalizeRecipientPhone(`+${input}`);
  if (!normalized.ok || normalized.e164.slice(1) !== input) throw invalid();
  return input;
}

export function parseWooRecoverySelectionChange(input: unknown): WooRecoverySelectionChange {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const data = input as Record<string, unknown>;
  const keys = ["schemaVersion", "canonicalPhone", "action", "expectedNoContactRevision", "evidenceReference"];
  if (Object.keys(data).length !== keys.length || Object.keys(data).some(key => !keys.includes(key)) ||
    data.schemaVersion !== WOO_RECOVERY_SELECTION_VERSION ||
    !["SUPPRESS", "REENABLE", "RECORD_CUSTOMER_STOP"].includes(String(data.action)) ||
    typeof data.expectedNoContactRevision !== "string" || !revision.test(data.expectedNoContactRevision) ||
    BigInt(data.expectedNoContactRevision) > maxPgBigint) throw invalid();
  const action = data.action as RecoverySelectionCommand;
  const reference = data.evidenceReference;
  if (action === "RECORD_CUSTOMER_STOP" ?
    (typeof reference !== "string" || !ref.test(reference)) : reference !== null) throw invalid();
  return {
    schemaVersion: WOO_RECOVERY_SELECTION_VERSION,
    canonicalPhone: parseCanonicalPhone(data.canonicalPhone),
    action, expectedNoContactRevision: data.expectedNoContactRevision,
    evidenceReference: reference as string | null,
  };
}

/** Browser authentication and WP nonce/capability checks are WordPress-owned.
 * The server-side plugin must set this header ONLY after all three checks.
 * Installation bearer authentication is an independent hosted-API requirement. */
export const WP_ADMIN_VERIFIED_HEADER = "x-moda-wp-admin-verified";
