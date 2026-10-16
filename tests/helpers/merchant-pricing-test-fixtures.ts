/** Canonical supported locales for READY MerchantPricingPlan fixtures.
 * Real migrations enforce the complete translated catalogue at commit time.
 */
const merchantPricingLocales = [
  "cs", "da", "de", "en", "es", "fi", "fr", "it", "ja", "ko",
  "nb", "nl", "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant",
] as const;

export function publishedPricingTranslations(description: string):
  Array<{ locale: string; merchantDescription: string }> {
  return merchantPricingLocales.map((locale) => ({ locale, merchantDescription: description }));
}
