/** Read the canonical Shopify-authored prompt source context defensively.
 * Only bounded mapping IDs are returned; no raw prompt/revision text escapes.
 */
export function selectedMappingIds(context: unknown, expectedCategoryId: string | null): string[] {
  if (!expectedCategoryId || !context || typeof context !== "object" || Array.isArray(context)) return [];
  const value = context as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.kind !== "STORE_CATEGORY_SELECTION" ||
    value.categoryId !== expectedCategoryId ||
    typeof value.categoryEditVersion !== "number" || !Number.isSafeInteger(value.categoryEditVersion) ||
    typeof value.templateId !== "string" || !value.templateId ||
    typeof value.templateEditVersion !== "number" || !Number.isSafeInteger(value.templateEditVersion) ||
    !Array.isArray(value.mappings) || value.mappings.length > 256) return [];
  const selected: string[] = [];
  for (const raw of value.mappings) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const row = raw as Record<string, unknown>;
    if (typeof row.mappingId !== "string" || row.mappingId.length < 1 || row.mappingId.length > 128 ||
      typeof row.mappingEditVersion !== "number" || !Number.isSafeInteger(row.mappingEditVersion) ||
      typeof row.conditionKey !== "string" || !row.conditionKey ||
      selected.includes(row.mappingId)) return [];
    selected.push(row.mappingId);
  }
  return selected;
}
