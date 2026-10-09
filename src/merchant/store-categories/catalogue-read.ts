import type { PrismaClient } from "@prisma/client";
import { localizeCategory, localizeMapping, StoreCategoryReadError, type CategoryPresentationLocale } from "./locale.js";
import type { StoreCategoryChoice } from "./schema.js";

export type CategoryCatalogueDatabase = Pick<PrismaClient, "commercePromptTemplateCategory">;
const MAX_CATEGORIES = 100;
const MAX_MAPPINGS_PER_CATEGORY = 50;
const CONDITION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;

/** Mirrors Shopify's category/template eligibility, sorted mappings and localized fallbacks. */
export async function readSelectableCategories(
  database: CategoryCatalogueDatabase,
  locale: CategoryPresentationLocale,
): Promise<StoreCategoryChoice[]> {
  const categories = await database.commercePromptTemplateCategory.findMany({
    where: { enabled: true, defaultTemplateId: { not: null } },
    orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    take: MAX_CATEGORIES + 1,
    select: {
      id: true,
      slug: true,
      displayName: true,
      description: true,
      defaultTemplate: {
        select: { id: true, categoryId: true, enabled: true, promptText: true, key: true, displayName: true, editVersion: true },
      },
      translations: {
        where: { locale: { in: locale.translationLocales } },
        select: { locale: true, displayName: true, description: true },
      },
      taxonomyMappings: {
        where: { conditionKey: { not: null } },
        orderBy: [{ weight: "desc" }, { id: "asc" }],
        take: MAX_MAPPINGS_PER_CATEGORY + 1,
        select: {
          id: true,
          conditionKey: true,
          displayName: true,
          taxonomyCategoryName: true,
          translations: {
            where: { locale: { in: locale.translationLocales } },
            select: { locale: true, displayName: true },
          },
        },
      },
    },
  });
  if (categories.length > MAX_CATEGORIES) throw new StoreCategoryReadError("store_category_integrity_invalid");

  return categories.flatMap((category) => {
    const template = category.defaultTemplate;
    if (!template || !template.enabled || template.categoryId !== category.id || !template.promptText.trim()) return [];
    if (category.taxonomyMappings.length > MAX_MAPPINGS_PER_CATEGORY) {
      throw new StoreCategoryReadError("store_category_integrity_invalid");
    }
    return [{
      id: category.id,
      slug: category.slug,
      ...localizeCategory(category, locale),
      mappings: category.taxonomyMappings.flatMap((mapping) =>
        mapping.conditionKey && CONDITION_KEY_PATTERN.test(mapping.conditionKey) &&
        !["constructor", "prototype", "__proto__"].includes(mapping.conditionKey)
          ? [{ id: mapping.id, conditionKey: mapping.conditionKey, ...localizeMapping(mapping, locale) }]
          : [],
      ),
      defaultTemplate: {
        id: template.id,
        key: template.key,
        displayName: template.displayName,
        editVersion: template.editVersion,
      },
    }];
  });
}
