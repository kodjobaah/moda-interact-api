/** Versioned, installation-scoped feature-preference wire contract. */
export const MERCHANT_FEATURE_PREFERENCES_PATH = "/v1/merchant/feature-preferences";
export const MAX_FEATURE_PREFERENCE_BODY_BYTES = 65536;
export const MAX_FEATURE_PREFERENCE_CHANGES = 1000;
export const MAX_FEATURE_PREFERENCE_FEATURES = 1000;

export interface FeaturePreferenceRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  effective: boolean;
  editable: boolean;
  required: boolean;
  planEligible: boolean;
}

export interface FeaturePreferencesResponse {
  schemaVersion: 1;
  revision: string;
  features: FeaturePreferenceRow[];
}

export interface FeaturePreferencesUpdate {
  expectedRevision: string;
  changes: Array<{ featureId: string; enabled: boolean }>;
}

export class FeaturePreferencesRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: "invalid_request" | "request_too_large") {
    super(code);
  }
}

export class FeaturePreferencesConflictError extends Error {
  constructor(readonly code: "feature_preferences_conflict" | "feature_preferences_denied" | "feature_preferences_unavailable") {
    super(code);
  }
}

export class FeaturePreferencesIntegrityError extends Error {
  constructor() { super("feature_preferences_integrity_invalid"); }
}

const sha256 = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const own = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");

export function parseFeaturePreferencesUpdate(input: unknown): FeaturePreferencesUpdate {
  if (!own(input) || !exactly(input, ["expectedRevision", "changes"]) ||
    typeof input.expectedRevision !== "string" || !sha256.test(input.expectedRevision) ||
    !Array.isArray(input.changes) || input.changes.length > MAX_FEATURE_PREFERENCE_CHANGES) {
    throw new FeaturePreferencesRequestError(400, "invalid_request");
  }
  const ids = new Set<string>();
  const changes: FeaturePreferencesUpdate["changes"] = [];
  for (const row of input.changes) {
    if (!own(row) || !exactly(row, ["featureId", "enabled"]) ||
      typeof row.featureId !== "string" || !identifier.test(row.featureId) ||
      typeof row.enabled !== "boolean" || ids.has(row.featureId)) {
      throw new FeaturePreferencesRequestError(400, "invalid_request");
    }
    ids.add(row.featureId);
    changes.push({ featureId: row.featureId, enabled: row.enabled });
  }
  return { expectedRevision: input.expectedRevision, changes };
}

/** Output is validated too, so no unapproved DB fields escape into merchant responses. */
export function isFeaturePreferencesResponse(input: unknown): input is FeaturePreferencesResponse {
  if (!own(input) || !exactly(input, ["schemaVersion", "revision", "features"]) ||
    input.schemaVersion !== 1 || typeof input.revision !== "string" || !sha256.test(input.revision) ||
    !Array.isArray(input.features) || input.features.length > MAX_FEATURE_PREFERENCE_FEATURES) return false;
  const ids = new Set<string>();
  for (const row of input.features) {
    if (!own(row) || !exactly(row, ["id", "key", "name", "description", "enabled", "effective", "editable", "required", "planEligible"]) ||
      typeof row.id !== "string" || !identifier.test(row.id) || ids.has(row.id) ||
      typeof row.key !== "string" || !identifier.test(row.key) ||
      typeof row.name !== "string" || row.name.length === 0 || row.name.length > 255 ||
      !(row.description === null || (typeof row.description === "string" && row.description.length <= 10000)) ||
      !["enabled", "effective", "editable", "required", "planEligible"].every((key) => typeof row[key] === "boolean") ||
      (row.editable && (!row.planEligible || row.required)) || (row.effective && !row.planEligible)) return false;
    ids.add(row.id);
  }
  return true;
}
