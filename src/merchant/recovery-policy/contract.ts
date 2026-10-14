import { parseEffectiveRecoveryPolicy } from "@modainteract/moda-interact-shared/recovery-policy";

export const MERCHANT_RECOVERY_POLICY_ROUTE_PATH = "/v1/merchant/recovery-policy";
export const MAX_RECOVERY_POLICY_BODY_BYTES = 2048;

export interface RecoveryPolicyValues {
  recoveryDelayMinutes: number;
  recoveryOfferMode: "NONE" | "FIXED" | "AI_BEST_APPLICABLE";
  followUpEnabled: boolean;
  followUpDelayMinutes: number | null;
}

export interface MerchantRecoveryPolicyResponse {
  schemaVersion: 1;
  revision: string;
  merchant: RecoveryPolicyValues;
  effective: RecoveryPolicyValues;
  source: "MERCHANT" | "ADMIN_OVERRIDE";
  overrideActive: boolean;
  offerSelectionAvailable: false;
}

export interface RecoveryPolicyUpdate {
  expectedRevision: string;
  recoveryDelayMinutes: number;
  followUpEnabled: boolean;
  followUpDelayMinutes: number | null;
}

export class RecoveryPolicyRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: "invalid_request" | "request_too_large") {
    super(code);
  }
}

export class RecoveryPolicyConflictError extends Error {
  constructor(readonly code: "recovery_policy_conflict" | "recovery_offer_unsupported") {
    super(code);
  }
}

export class RecoveryPolicyIntegrityError extends Error {
  constructor() {
    super("recovery_policy_integrity_invalid");
  }
}

const revisionPattern = /^(?:UNCONFIGURED|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/** Strictly parse the write-only merchant fields. A Woo merchant cannot select a Shopify discount. */
export function parseRecoveryPolicyUpdate(input: unknown): RecoveryPolicyUpdate {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RecoveryPolicyRequestError(400, "invalid_request");
  const body = input as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== ["expectedRevision", "followUpDelayMinutes", "followUpEnabled", "recoveryDelayMinutes"].sort().join(",")) {
    throw new RecoveryPolicyRequestError(400, "invalid_request");
  }
  if (typeof body.expectedRevision !== "string" || !revisionPattern.test(body.expectedRevision) ||
    (body.expectedRevision !== "UNCONFIGURED" && !Number.isFinite(Date.parse(body.expectedRevision))) ||
    !Number.isInteger(body.recoveryDelayMinutes) || (body.recoveryDelayMinutes as number) < 0 ||
    (body.recoveryDelayMinutes as number) > 10080 || typeof body.followUpEnabled !== "boolean") {
    throw new RecoveryPolicyRequestError(400, "invalid_request");
  }
  if (body.followUpEnabled) {
    if (!Number.isInteger(body.followUpDelayMinutes) || (body.followUpDelayMinutes as number) < 1 ||
      (body.followUpDelayMinutes as number) > 10080) throw new RecoveryPolicyRequestError(400, "invalid_request");
  } else if (body.followUpDelayMinutes !== null) {
    throw new RecoveryPolicyRequestError(400, "invalid_request");
  }
  return {
    expectedRevision: body.expectedRevision,
    recoveryDelayMinutes: body.recoveryDelayMinutes as number,
    followUpEnabled: body.followUpEnabled,
    followUpDelayMinutes: body.followUpDelayMinutes as number | null,
  };
}

/** Validate the exact outgoing DTO; never pass arbitrary DB/provider fields to the merchant browser. */
export function isRecoveryPolicyResponse(input: unknown): input is MerchantRecoveryPolicyResponse {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  const exact = (object: Record<string, unknown>, names: string[]) =>
    Object.keys(object).sort().join(",") === names.sort().join(",");
  if (!exact(value, ["schemaVersion", "revision", "merchant", "effective", "source", "overrideActive", "offerSelectionAvailable"]) ||
    value.schemaVersion !== 1 || typeof value.revision !== "string" || !revisionPattern.test(value.revision) ||
    !["MERCHANT", "ADMIN_OVERRIDE"].includes(String(value.source)) || typeof value.overrideActive !== "boolean" ||
    value.overrideActive !== (value.source === "ADMIN_OVERRIDE") || value.offerSelectionAvailable !== false) return false;
  for (const field of ["merchant", "effective"] as const) {
    const item = value[field];
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const policy = item as Record<string, unknown>;
    if (!exact(policy, ["recoveryDelayMinutes", "recoveryOfferMode", "followUpEnabled", "followUpDelayMinutes"])) return false;
    try {
      parseEffectiveRecoveryPolicy({ ...policy, fixedShopifyDiscountId: policy.recoveryOfferMode === "FIXED" ? "validated-without-exposing-provider-id" : null,
        source: field === "effective" ? value.source : "MERCHANT" });
    } catch { return false; }
  }
  return true;
}
