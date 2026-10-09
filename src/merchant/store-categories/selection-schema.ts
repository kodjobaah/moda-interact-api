/** API-006 request and result are versioned; the caller cannot name a Shop or environment. */
export interface StoreCategorySelectionRequest {
  schemaVersion: 1;
  categoryId: string;
  selectedMappingIds: string[];
  expectedPendingSelectionGeneration: number;
}

export interface StoreCategorySelectionResponse {
  schemaVersion: 1;
  activeCategoryId: string;
  activePromptRevisionId: string;
  activeMappingIds: string[];
  pendingSelectionGeneration: number;
}

const KEYS = ["schemaVersion", "categoryId", "selectedMappingIds", "expectedPendingSelectionGeneration"] as const;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_SELECTED_CATEGORY_MAPPINGS = 50;

export function isStoreCategorySelectionRequest(value: unknown): value is StoreCategorySelectionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(record, key))) return false;
  if (record.schemaVersion !== 1 || typeof record.categoryId !== "string" || !IDENTIFIER.test(record.categoryId)) return false;
  if (typeof record.expectedPendingSelectionGeneration !== "number" ||
    !Number.isSafeInteger(record.expectedPendingSelectionGeneration) || record.expectedPendingSelectionGeneration < 0 ||
    record.expectedPendingSelectionGeneration === Number.MAX_SAFE_INTEGER) return false;
  if (!Array.isArray(record.selectedMappingIds) || record.selectedMappingIds.length > MAX_SELECTED_CATEGORY_MAPPINGS ||
    record.selectedMappingIds.some((id) => typeof id !== "string" || !IDENTIFIER.test(id))) return false;
  return new Set(record.selectedMappingIds).size === record.selectedMappingIds.length;
}
