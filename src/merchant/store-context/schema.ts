/** The complete WooCommerce storefront settings snapshot, not a partial patch. */
export interface MerchantStoreContextSnapshot {
  schemaVersion: 1;
  storeLocale: string | null;
  languageTag: string | null;
  timeZone: string | null;
  countryCode: string | null;
}

const FIELDS = ["schemaVersion", "storeLocale", "languageTag", "timeZone", "countryCode"] as const;

export function isMerchantStoreContextSnapshot(value: unknown): value is MerchantStoreContextSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== FIELDS.length || !FIELDS.every((key) => Object.hasOwn(record, key))) return false;
  return record.schemaVersion === 1 &&
    validStoreLocale(record.storeLocale) &&
    validLanguageTag(record.languageTag) &&
    validTimeZone(record.timeZone) &&
    validCountryCode(record.countryCode);
}

function validStoreLocale(value: unknown): boolean {
  // Preserve WordPress's provider-native identity; never gate it on Moda translations.
  // Reject whitespace/control characters, markup and arbitrary free text.
  return value === null || (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9_.@-]*$/.test(value)
  );
}

function validLanguageTag(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9-]+$/.test(value)) return false;
  try {
    // Validate BCP-47 syntax, but preserve the merchant-provided value verbatim.
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function validTimeZone(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 255 || !/^[A-Za-z][A-Za-z0-9_./+-]*$/.test(value)) return false;
  // Node's Intl accepts some bare offset forms. They are not named IANA zones.
  if (/^(?:UTC|GMT)[+-]/i.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validCountryCode(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^[A-Z]{2}$/.test(value));
}
