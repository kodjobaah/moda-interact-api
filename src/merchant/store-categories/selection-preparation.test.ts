import assert from "node:assert/strict";
import test from "node:test";
import { assertCategorySelectionStillCurrent, prepareCategorySelection } from "./selection-preparation.js";
import { StoreCategorySelectionError } from "./selection-errors.js";

const category = {
  id: "cat_1", editVersion: 3, enabled: true, defaultTemplateId: "template_1",
  defaultTemplate: { id: "template_1", categoryId: "cat_1", editVersion: 4, enabled: true,
    promptText: "Base. {% if mappings.shoes %}Footwear.{% else %}General.{% endif %}" },
  taxonomyMappings: [{ id: "map_1", categoryId: "cat_1", conditionKey: "shoes", editVersion: 5 }],
};
const input = { schemaVersion: 1 as const, categoryId: "cat_1", selectedMappingIds: ["map_1"], expectedPendingSelectionGeneration: 0 };

function db(row: unknown = category) {
  return { commercePromptTemplateCategory: { findUnique: async () => row } } as never;
}

test("prepares Shopify-compatible rendered prompt, sorted mapping provenance and hash without writes", async () => {
  const prepared = await prepareCategorySelection(db(), input);
  assert.equal(prepared.promptText, "Base. Footwear.");
  assert.equal(prepared.templateEditVersion, 4);
  assert.deepEqual(prepared.sourceContext, {
    schemaVersion: 1, kind: "STORE_CATEGORY_SELECTION", categoryId: "cat_1", categoryEditVersion: 3,
    templateId: "template_1", templateEditVersion: 4,
    mappings: [{ mappingId: "map_1", mappingEditVersion: 5, conditionKey: "shoes" }],
  });
  await assertCategorySelectionStillCurrent(db() as never, prepared);
});

test("rejects foreign mapping, disabled template and unsupported conditional syntax", async () => {
  for (const bad of [
    { ...category, defaultTemplate: { ...category.defaultTemplate, enabled: false } },
    { ...category, taxonomyMappings: [] },
    { ...category, defaultTemplate: { ...category.defaultTemplate, promptText: "{{ code }}" } },
  ]) await assert.rejects(prepareCategorySelection(db(bad), input), StoreCategorySelectionError);
});

test("rejects category/template/mapping drift between preparation and publication", async () => {
  const prepared = await prepareCategorySelection(db(), input);
  for (const changed of [
    { ...category, editVersion: 9 },
    { ...category, defaultTemplate: { ...category.defaultTemplate, promptText: "changed" } },
    { ...category, defaultTemplate: { ...category.defaultTemplate, editVersion: 6 } },
    { ...category, taxonomyMappings: [{ ...category.taxonomyMappings[0], editVersion: 8 }] },
    { ...category, taxonomyMappings: [] },
  ]) await assert.rejects(assertCategorySelectionStillCurrent(db(changed) as never, prepared), StoreCategorySelectionError);
});
