/** Woo WordPress Site Identity -> hosted Moda ShopBrand snapshot. */
export const WOO_SHOP_BRAND_PATH = "/v1/woocommerce/shop-brand";
export const WOO_SHOP_BRAND_VERSION = "woo.shop-brand.v1";
export const MAX_WOO_SHOP_BRAND_BYTES = 16 * 1024;

export type ShopBrandRole = "LOGO" | "SQUARE_LOGO" | "COVER_IMAGE";

export interface WooBrandImage {
  url: string | null;
  attachmentId: number | null;
  altText: string | null;
  width: number | null;
  height: number | null;
}

/** All three media fields are required, even when their value is null. */
export interface WooShopBrandSnapshot {
  schemaVersion: typeof WOO_SHOP_BRAND_VERSION;
  eventId: string;
  observedAt: string;
  brandName: string | null;
  logo: WooBrandImage | null;
  siteIcon: WooBrandImage | null;
  coverImage: WooBrandImage | null;
}

export interface WooShopBrandResult { status: "updated" | "unchanged" }

export class WooShopBrandHttpError extends Error {
  constructor(readonly status: 400 | 413, readonly code: "invalid_request" | "request_too_large") {
    super(code);
  }
}

function invalid(): WooShopBrandHttpError { return new WooShopBrandHttpError(400, "invalid_request"); }
function objectWithKeys(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw invalid();
  }
  return value;
}
function stringValue(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || !allowEmpty && !value.length || [...value].length > max) throw invalid();
  // Reject unpaired UTF-16 surrogates, which can be smuggled through JSON escapes,
  // and unsafe control characters. Other Unicode letters are deliberately valid.
  for (let index = 0; index < value.length; index++) {
    const point = value.charCodeAt(index);
    if (point < 0x20 || point === 0x7f) throw invalid();
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid();
    } else if (point >= 0xdc00 && point <= 0xdfff) throw invalid();
  }
  return value;
}
function nullableText(value: unknown, max: number): string | null {
  if (value === null) return null;
  const trimmed = stringValue(value, max, true).trim();
  if ([...trimmed].length > max) throw invalid();
  return trimmed || null;
}
function positiveInteger(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw invalid();
  return value;
}
function httpsUrl(value: unknown): string | null {
  if (value === null) return null;
  const url = stringValue(value, 2048);
  if (url.trim() !== url || /\s/u.test(url)) throw invalid();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
      throw invalid();
    }
  } catch { throw invalid(); }
  return url; // Preserve the merchant's original source, not a reserialised URL.
}
function image(value: unknown): WooBrandImage | null {
  if (value === null) return null;
  const data = objectWithKeys(value, ["url", "attachmentId", "altText", "width", "height"]);
  return {
    url: httpsUrl(data.url),
    attachmentId: positiveInteger(data.attachmentId),
    altText: nullableText(data.altText, 512),
    width: positiveInteger(data.width),
    height: positiveInteger(data.height),
  };
}
function observedAt(value: unknown): string {
  const input = stringValue(value, 27);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input)) throw invalid();
  const time = Date.parse(input);
  if (!Number.isFinite(time)) throw invalid();
  const canonical = new Date(time).toISOString();
  if (canonical.slice(0, 19) !== input.slice(0, 19)) throw invalid();
  return canonical;
}

export function parseWooShopBrandSnapshot(input: unknown): WooShopBrandSnapshot {
  const data = objectWithKeys(input, [
    "schemaVersion", "eventId", "observedAt", "brandName", "logo", "siteIcon", "coverImage",
  ]);
  if (data.schemaVersion !== WOO_SHOP_BRAND_VERSION) throw invalid();
  const eventId = stringValue(data.eventId, 128);
  // Opaque retry identifier, not an arbitrary log line or URL.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(eventId)) throw invalid();
  return {
    schemaVersion: WOO_SHOP_BRAND_VERSION,
    eventId,
    observedAt: observedAt(data.observedAt),
    brandName: nullableText(data.brandName, 160),
    logo: image(data.logo),
    siteIcon: image(data.siteIcon),
    coverImage: image(data.coverImage),
  };
}
