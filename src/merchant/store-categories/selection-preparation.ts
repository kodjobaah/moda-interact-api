import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createStoreCategoryPromptContext,
  renderStoreCategoryPromptTemplate,
} from "@modainteract/moda-interact-shared/commerce";
import { createStoreCategorySelectionSourceContext } from "./provenance.js";
import { categoryConflict, StoreCategorySelectionError } from "./selection-errors.js";
import type { StoreCategorySelectionRequest } from "./selection-schema.js";

export type CategorySelectionCatalogue = Pick<PrismaClient, "commercePromptTemplateCategory">;
type SelectedMapping = { id: string; editVersion: number; conditionKey: string };
const CONDITION_KEY = /^[a-z][a-z0-9_]{0,127}$/;
const FORBIDDEN = new Set(["constructor", "prototype", "__proto__"]);
const MAX_AVAILABLE_MAPPINGS = 50; // Same limit as API-005 category choices.

export interface PreparedCategorySelection {
  categoryId: string;
  categoryEditVersion: number;
  templateId: string;
  templateEditVersion: number;
  templateSourceHash: string;
  promptText: string;
  sourceContext: Prisma.InputJsonValue;
  selectedMappings: SelectedMapping[];
  availableConditionKeys: string[];
}

const sourceHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const usableKey = (key: string | null): key is string => !!key && CONDITION_KEY.test(key) && !FORBIDDEN.has(key);

/** Render before taking the Shop lock. No database changes or network calls. */
export async function prepareCategorySelection(
  database: CategorySelectionCatalogue,
  input: StoreCategorySelectionRequest,
): Promise<PreparedCategorySelection> {
  const category = await database.commercePromptTemplateCategory.findUnique({
    where: { id: input.categoryId },
    include: {
      defaultTemplate: true,
      taxonomyMappings: { where: { conditionKey: { not: null } }, orderBy: [{ weight: "desc" }, { id: "asc" }] },
    },
  });
  const template = category?.defaultTemplate;
  if (!category?.enabled || !template?.enabled || template.categoryId !== category.id ||
    category.defaultTemplateId !== template.id || !template.promptText.trim() ||
    category.taxonomyMappings.length > MAX_AVAILABLE_MAPPINGS) {
    throw new StoreCategorySelectionError("category_unavailable");
  }

  const eligible = category.taxonomyMappings.filter((mapping) => usableKey(mapping.conditionKey));
  const byId = new Map(eligible.map((mapping) => [mapping.id, mapping]));
  const selectedMappings: SelectedMapping[] = [];
  for (const id of input.selectedMappingIds) {
    const mapping = byId.get(id);
    if (!mapping || !usableKey(mapping.conditionKey)) throw new StoreCategorySelectionError("category_unavailable");
    selectedMappings.push({ id: mapping.id, editVersion: mapping.editVersion, conditionKey: mapping.conditionKey });
  }
  const availableConditionKeys = eligible.flatMap((mapping) =>
    usableKey(mapping.conditionKey) ? [mapping.conditionKey] : [],
  ).sort();
  let rendered: ReturnType<typeof renderStoreCategoryPromptTemplate>;
  try {
    rendered = renderStoreCategoryPromptTemplate({
      source: template.promptText,
      context: createStoreCategoryPromptContext({
        availableConditionKeys,
        selectedConditionKeys: selectedMappings.map((mapping) => mapping.conditionKey),
      }),
    });
  } catch {
    throw new StoreCategorySelectionError("category_unavailable");
  }
  if (!rendered.ok || !rendered.promptText.trim()) throw new StoreCategorySelectionError("category_unavailable");
  return {
    categoryId: category.id,
    categoryEditVersion: category.editVersion,
    templateId: template.id,
    templateEditVersion: template.editVersion,
    templateSourceHash: sourceHash(template.promptText),
    promptText: rendered.promptText,
    sourceContext: createStoreCategorySelectionSourceContext({
      categoryId: category.id,
      categoryEditVersion: category.editVersion,
      templateId: template.id,
      templateEditVersion: template.editVersion,
      mappings: selectedMappings,
    }) as Prisma.InputJsonValue,
    selectedMappings,
    availableConditionKeys,
  };
}

/** Detect catalogue/template/mapping changes between preparation and commit. */
export async function assertCategorySelectionStillCurrent(
  tx: Prisma.TransactionClient,
  prepared: PreparedCategorySelection,
): Promise<void> {
  const category = await tx.commercePromptTemplateCategory.findUnique({
    where: { id: prepared.categoryId },
    select: {
      id: true, enabled: true, editVersion: true, defaultTemplateId: true,
      defaultTemplate: {
        select: { id: true, enabled: true, categoryId: true, editVersion: true, promptText: true },
      },
      taxonomyMappings: {
        where: { conditionKey: { not: null } },
        select: { id: true, categoryId: true, conditionKey: true, editVersion: true },
      },
    },
  });
  const template = category?.defaultTemplate;
  if (!category?.enabled || category.editVersion !== prepared.categoryEditVersion ||
    category.defaultTemplateId !== prepared.templateId || !template?.enabled ||
    template.id !== prepared.templateId || template.categoryId !== category.id ||
    template.editVersion !== prepared.templateEditVersion ||
    sourceHash(template.promptText) !== prepared.templateSourceHash ||
    category.taxonomyMappings.length > MAX_AVAILABLE_MAPPINGS) throw categoryConflict();

  const eligible = category.taxonomyMappings.filter((mapping) => usableKey(mapping.conditionKey));
  const keys = eligible.flatMap((mapping) =>
    usableKey(mapping.conditionKey) ? [mapping.conditionKey] : [],
  ).sort();
  if (keys.length !== prepared.availableConditionKeys.length ||
    keys.some((key, index) => key !== prepared.availableConditionKeys[index])) throw categoryConflict();
  const byId = new Map(eligible.map((mapping) => [mapping.id, mapping]));
  for (const selected of prepared.selectedMappings) {
    const current = byId.get(selected.id);
    if (!current || current.categoryId !== prepared.categoryId ||
      current.editVersion !== selected.editVersion || current.conditionKey !== selected.conditionKey) throw categoryConflict();
  }
}
