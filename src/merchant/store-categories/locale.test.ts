import assert from "node:assert/strict";
import test from "node:test";
import { categoryPresentationLocale, localizeCategory, localizeMapping, StoreCategoryReadError } from "./locale.js";

test("administrator locale is independent of Shop store locale and normalized to a supported translation", () => {
  assert.deepEqual(categoryPresentationLocale("en_GB"), {
    requestedLocale: "en-GB", resolvedLocale: "en", translationLocales: ["en"],
  });
  assert.deepEqual(categoryPresentationLocale("pt_BR"), {
    requestedLocale: "pt-BR", resolvedLocale: "pt-BR", translationLocales: ["pt-BR", "en"],
  });
  assert.equal(categoryPresentationLocale("es-MX").resolvedLocale, "es");
  assert.equal(categoryPresentationLocale("xx-YY").resolvedLocale, "en");
  assert.equal(categoryPresentationLocale().resolvedLocale, "en");
});

test("locale validation rejects malformed, duplicate-like and unbounded input", () => {
  for (const value of ["", " ", "en@@", "x".repeat(65), "../../private", "invalid=value"]) {
    assert.throws(() => categoryPresentationLocale(value), StoreCategoryReadError);
  }
});

test("category and mapping translations follow Shopify's selected -> English -> original fallback", () => {
  const category = {
    displayName: "Original", description: "Original text",
    translations: [
      { locale: "en", displayName: "English", description: "English desc" },
      { locale: "pt-BR", displayName: "Português", description: "Descrição" },
    ],
  };
  assert.deepEqual(localizeCategory(category, categoryPresentationLocale("pt_BR")), {
    localizedDisplayName: "Português", localizedDescription: "Descrição",
  });
  assert.equal(localizeCategory(category, categoryPresentationLocale("fr" )).localizedDisplayName, "English");
  assert.equal(localizeMapping({ conditionKey: "shirts", displayName: null, taxonomyCategoryName: "Clothes", translations: [] },
    categoryPresentationLocale("fr")).localizedDisplayName, "Clothes");
});
