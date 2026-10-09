import { CommerceAgentPromptScope, type CommerceEnvironment, type PrismaClient } from "@prisma/client";
import { localizeCategory, StoreCategoryReadError, type CategoryPresentationLocale } from "./locale.js";
import type { StoreCategoryProfile } from "./schema.js";
import { selectedMappingIds } from "./provenance.js";

export type CategoryProfileDatabase = Pick<PrismaClient, "commerceShopProfile" | "commerceAgentConfiguration">;

/** Reads active/pending states separately; a missing profile is not an error. */
export async function readStoreCategoryProfile(
  database: CategoryProfileDatabase,
  shopId: string,
  locale: CategoryPresentationLocale,
  environment: CommerceEnvironment,
): Promise<StoreCategoryProfile> {
  const [profile, configurations] = await Promise.all([
    database.commerceShopProfile.findUnique({
      where: { shopId },
      select: {
        shopId: true,
        activeCategoryId: true,
        pendingCategoryId: true,
        pendingSelectionGeneration: true,
        pendingSelectedAt: true,
        pendingPromptRevisionId: true,
        activeCategory: {
          select: {
            id: true, slug: true, displayName: true, description: true,
            translations: { where: { locale: { in: locale.translationLocales } }, select: { locale: true, displayName: true, description: true } },
          },
        },
        pendingCategory: {
          select: {
            id: true, slug: true, displayName: true, description: true,
            translations: { where: { locale: { in: locale.translationLocales } }, select: { locale: true, displayName: true, description: true } },
          },
        },
        pendingPromptRevision: {
          select: {
            sourceContext: true,
            sourceTemplateEditVersion: true,
            sourceTemplate: { select: { id: true, key: true, displayName: true } },
          },
        },
      },
    }),
    database.commerceAgentConfiguration.findMany({
      where: { environment, scope: CommerceAgentPromptScope.SHOP, shopId },
      take: 2,
      select: { activePromptRevision: { select: { sourceContext: true } } },
    }),
  ]);
  if (configurations.length > 1 || (profile && (
    profile.shopId !== shopId || !Number.isSafeInteger(profile.pendingSelectionGeneration) ||
    profile.pendingSelectionGeneration < 0 ||
    (profile.activeCategoryId === null) !== (profile.activeCategory === null) ||
    (profile.activeCategory !== null && profile.activeCategory.id !== profile.activeCategoryId) ||
    (profile.pendingCategoryId === null) !== (profile.pendingCategory === null) ||
    (profile.pendingCategory !== null && profile.pendingCategory.id !== profile.pendingCategoryId) ||
    (profile.pendingPromptRevisionId === null) !== (profile.pendingPromptRevision === null) ||
    (profile.pendingPromptRevisionId !== null && profile.pendingCategoryId === null)
  ))) throw new StoreCategoryReadError("store_category_integrity_invalid");

  const localized = (category: NonNullable<typeof profile>['activeCategory']) => category ? {
    id: category.id, slug: category.slug, ...localizeCategory(category, locale),
  } : null;
  const template = profile?.pendingPromptRevision?.sourceTemplate;
  return {
    activeCategory: localized(profile?.activeCategory ?? null),
    pendingCategory: localized(profile?.pendingCategory ?? null),
    pendingSelectionGeneration: profile?.pendingSelectionGeneration ?? 0,
    pendingSelectedAt: profile?.pendingSelectedAt?.toISOString() ?? null,
    activeMappingIds: selectedMappingIds(
      configurations[0]?.activePromptRevision?.sourceContext,
      profile?.activeCategoryId ?? null,
    ),
    pendingMappingIds: selectedMappingIds(
      profile?.pendingPromptRevision?.sourceContext,
      profile?.pendingCategoryId ?? null,
    ),
    pendingState: profile?.pendingPromptRevisionId ? "PENDING_PUBLICATION" : "NONE",
    pendingTemplate: template ? {
      id: template.id, key: template.key, displayName: template.displayName,
      editVersion: profile?.pendingPromptRevision?.sourceTemplateEditVersion ?? null,
    } : null,
  };
}
