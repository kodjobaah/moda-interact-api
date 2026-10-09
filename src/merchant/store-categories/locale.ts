import { resolveModaConfigurationLocale, type ModaSupportedLanguageTag } from "@modainteract/moda-interact-shared/internationalization";

export class StoreCategoryReadError extends Error {
  constructor(readonly code: "invalid_locale" | "store_category_integrity_invalid") {
    super(code);
    this.name = "StoreCategoryReadError";
  }
}

export interface CategoryPresentationLocale {
  requestedLocale: string | null;
  resolvedLocale: ModaSupportedLanguageTag;
  translationLocales: string[];
}

/** The WordPress admin UI language is presentation-only, never Shop.storeLocale. */
export function categoryPresentationLocale(value?: string): CategoryPresentationLocale {
  let requestedLocale: string | null = null;
  if (value !== undefined) {
    if (Buffer.byteLength(value, "utf8") > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new StoreCategoryReadError("invalid_locale");
    }
    try {
      requestedLocale = Intl.getCanonicalLocales(value.replaceAll("_", "-"))[0] ?? null;
    } catch {
      throw new StoreCategoryReadError("invalid_locale");
    }
    if (!requestedLocale) throw new StoreCategoryReadError("invalid_locale");
  }
  const resolvedLocale = resolveModaConfigurationLocale(requestedLocale);
  return {
    requestedLocale,
    resolvedLocale,
    translationLocales: resolvedLocale === "en" ? ["en"] : [resolvedLocale, "en"],
  };
}

export interface CategoryTranslation {
  locale: string;
  displayName: string;
  description: string;
}
export interface MappingTranslation { locale: string; displayName: string }

function translated<T extends { locale: string }>(rows: T[], locale: string): T | undefined {
  return rows.find((entry) => entry.locale === locale);
}

export function localizeCategory(
  category: { displayName: string; description: string; translations: CategoryTranslation[] },
  locale: CategoryPresentationLocale,
) {
  const localized = translated(category.translations, locale.resolvedLocale);
  const english = translated(category.translations, "en");
  return {
    localizedDisplayName: (localized?.displayName ?? english?.displayName ?? category.displayName).slice(0, 255),
    localizedDescription: (localized?.description ?? english?.description ?? category.description).slice(0, 4096),
  };
}

export function localizeMapping(
  mapping: {
    conditionKey: string | null;
    displayName: string | null;
    taxonomyCategoryName: string | null;
    translations: MappingTranslation[];
  },
  locale: CategoryPresentationLocale,
) {
  const localized = translated(mapping.translations, locale.resolvedLocale);
  const english = translated(mapping.translations, "en");
  return {
    localizedDisplayName: (localized?.displayName ?? english?.displayName ?? mapping.displayName ??
      mapping.taxonomyCategoryName ?? mapping.conditionKey ?? "").slice(0, 255),
  };
}
