export interface MerchantCategoryIdentity {
  id: string;
  slug: string;
  displayName: string;
}

export interface MerchantBootstrapResponse {
  schemaVersion: 1;
  shop: {
    id: string;
    platform: "WOOCOMMERCE";
    domain: string;
    onboardingCompleted: boolean;
    installedAt: string;
  };
  internationalContext: {
    storeLocale: string | null;
    languageTag: string | null;
    timeZone: string | null;
    countryCode: string | null;
  };
  storeProfile: {
    activeCategory: MerchantCategoryIdentity | null;
    pendingCategory: MerchantCategoryIdentity | null;
    pendingSelectionGeneration: number;
    pendingSelectedAt: string | null;
  };
}

export type MerchantBootstrapErrorCode = "invalid_request" | "unauthorized" | "internal_error";

export interface MerchantBootstrapErrorResponse {
  error: MerchantBootstrapErrorCode;
}

export function isMerchantBootstrapResponse(value: unknown): value is MerchantBootstrapResponse {
  if (!hasExactKeys(value, ["schemaVersion", "shop", "internationalContext", "storeProfile"])) return false;
  const response = value as Record<string, unknown>;
  if (response.schemaVersion !== 1) return false;

  const shop = response.shop;
  if (!hasExactKeys(shop, ["id", "platform", "domain", "onboardingCompleted", "installedAt"])) return false;
  const shopRecord = shop as Record<string, unknown>;
  if (
    !boundedString(shopRecord.id, 128) ||
    shopRecord.platform !== "WOOCOMMERCE" ||
    !boundedString(shopRecord.domain, 512) ||
    typeof shopRecord.onboardingCompleted !== "boolean" ||
    !isIsoDateTime(shopRecord.installedAt)
  ) return false;

  const context = response.internationalContext;
  if (!hasExactKeys(context, ["storeLocale", "languageTag", "timeZone", "countryCode"])) return false;
  const contextRecord = context as Record<string, unknown>;
  if (
    !nullableBoundedString(contextRecord.storeLocale, 128) ||
    !nullableBoundedString(contextRecord.languageTag, 64) ||
    !nullableBoundedString(contextRecord.timeZone, 255) ||
    !nullableBoundedString(contextRecord.countryCode, 2)
  ) return false;

  const profile = response.storeProfile;
  if (!hasExactKeys(profile, ["activeCategory", "pendingCategory", "pendingSelectionGeneration", "pendingSelectedAt"])) return false;
  const profileRecord = profile as Record<string, unknown>;
  return (
    isCategoryIdentity(profileRecord.activeCategory) &&
    isCategoryIdentity(profileRecord.pendingCategory) &&
    Number.isSafeInteger(profileRecord.pendingSelectionGeneration) &&
    (profileRecord.pendingSelectionGeneration as number) >= 0 &&
    (profileRecord.pendingSelectedAt === null || isIsoDateTime(profileRecord.pendingSelectedAt))
  );
}

export function isMerchantBootstrapErrorResponse(value: unknown): value is MerchantBootstrapErrorResponse {
  if (!hasExactKeys(value, ["error"])) return false;
  const error = (value as Record<string, unknown>).error;
  return error === "invalid_request" || error === "unauthorized" || error === "internal_error";
}

function isCategoryIdentity(value: unknown): boolean {
  if (value === null) return true;
  if (!hasExactKeys(value, ["id", "slug", "displayName"])) return false;
  const category = value as Record<string, unknown>;
  return boundedString(category.id, 128) && boundedString(category.slug, 128) && boundedString(category.displayName, 255);
}

function hasExactKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function nullableBoundedString(value: unknown, maximum: number): value is string | null {
  return value === null || boundedString(value, maximum);
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}