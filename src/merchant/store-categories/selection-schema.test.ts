import assert from "node:assert/strict";
import test from "node:test";
import { isStoreCategorySelectionRequest } from "./selection-schema.js";

const input = {
  schemaVersion: 1, categoryId: "category_1", selectedMappingIds: ["map_2", "map_1"],
  expectedPendingSelectionGeneration: 0,
};

test("API-006 accepts a bounded versioned category selection", () => {
  assert.equal(isStoreCategorySelectionRequest(input), true);
  assert.equal(isStoreCategorySelectionRequest({ ...input, selectedMappingIds: [] }), true);
});

test("API-006 rejects cross-tenant/env fields, duplicate mappings and malformed generations", () => {
  for (const bad of [
    null, [], {}, { ...input, schemaVersion: 2 }, { ...input, shopId: "foreign" },
    { ...input, environment: "production" }, { ...input, selectedMappingIds: ["map_1", "map_1"] },
    { ...input, selectedMappingIds: Array(51).fill("map_1") },
    { ...input, selectedMappingIds: ["../bad"] },
    { ...input, expectedPendingSelectionGeneration: -1 },
    { ...input, expectedPendingSelectionGeneration: 1.5 },
    { ...input, expectedPendingSelectionGeneration: Number.MAX_SAFE_INTEGER },
    { ...input, categoryId: "" },
  ]) assert.equal(isStoreCategorySelectionRequest(bad), false, JSON.stringify(bad)?.slice(0, 120));
});
