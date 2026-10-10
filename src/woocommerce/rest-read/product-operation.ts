/** The first, deliberately narrow subset of the ARCH-030 Woo read catalogue. */
export type WooProductReadRequest =
  | { operation: "products.list"; page?: number; perPage?: number; search?: string }
  | { operation: "products.retrieve"; productId: number };

export type WooProductReadOperation = WooProductReadRequest["operation"];

export interface WooProductView {
  id: number;
  name: string;
  sku: string;
  price: string;
  stockStatus: "instock" | "outofstock" | "onbackorder" | null;
  stockQuantity: number | null;
}

export interface PreparedWooProductRequest {
  operation: WooProductReadOperation;
  path: string;
  maxItems: number;
  maxBytes: number;
}

export class WooProductInputError extends Error {
  constructor() { super("invalid_operation"); }
}

export class WooProductResponseError extends Error {
  constructor() { super("invalid_response"); }
}

const FIELDS = "id,name,sku,price,stock_status,stock_quantity";
const MAX_PAGE = 100;
const MAX_PER_PAGE = 20;
const MAX_DETAIL_BYTES = 32768;
const MAX_LIST_BYTES = 131072;

function positiveInt(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

/** Reject additional attributes, rather than allowing future callers to smuggle paths or headers. */
export function prepareWooProductRequest(value: unknown): PreparedWooProductRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WooProductInputError();
  const request = value as Record<string, unknown>;
  if (request.operation === "products.list") {
    if (Object.keys(request).some((key) => !["operation", "page", "perPage", "search"].includes(key))) {
      throw new WooProductInputError();
    }
    const page = request.page ?? 1;
    const perPage = request.perPage ?? 10;
    if (!positiveInt(page, MAX_PAGE) || !positiveInt(perPage, MAX_PER_PAGE)) throw new WooProductInputError();
    if (request.search !== undefined && (
      typeof request.search !== "string" || request.search.trim() !== request.search ||
      request.search.length < 1 || request.search.length > 100 || /[\x00-\x1f\x7f]/.test(request.search)
    )) throw new WooProductInputError();
    const query = new URLSearchParams({ context: "view", page: String(page), per_page: String(perPage), _fields: FIELDS });
    if (typeof request.search === "string") query.set("search", request.search);
    return {
      operation: "products.list", path: `/wp-json/wc/v3/products?${query.toString()}`,
      maxItems: perPage, maxBytes: MAX_LIST_BYTES,
    };
  }
  if (request.operation === "products.retrieve") {
    if (Object.keys(request).some((key) => !["operation", "productId"].includes(key)) ||
      !positiveInt(request.productId)) throw new WooProductInputError();
    const query = new URLSearchParams({ context: "view", _fields: FIELDS });
    return {
      operation: "products.retrieve", path: `/wp-json/wc/v3/products/${request.productId}?${query.toString()}`,
      maxItems: 1, maxBytes: MAX_DETAIL_BYTES,
    };
  }
  throw new WooProductInputError();
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
}

/** Only explicitly approved product fields leave the API, never raw provider objects. */
function productView(value: unknown): WooProductView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WooProductResponseError();
  const row = value as Record<string, unknown>;
  if (!positiveInt(row.id) || !boundedString(row.name, 1024) ||
      !boundedString(row.sku, 255) || !boundedString(row.price, 64) ||
      (row.stock_status !== null && row.stock_status !== "instock" &&
       row.stock_status !== "outofstock" && row.stock_status !== "onbackorder") ||
      (row.stock_quantity !== null &&
       (typeof row.stock_quantity !== "number" || !Number.isSafeInteger(row.stock_quantity) ||
        Math.abs(row.stock_quantity) > 1_000_000_000))) {
    throw new WooProductResponseError();
  }
  return {
    id: row.id, name: row.name, sku: row.sku, price: row.price,
    stockStatus: row.stock_status, stockQuantity: row.stock_quantity,
  } as WooProductView;
}

export function projectWooProducts(
  response: unknown,
  request: PreparedWooProductRequest,
): WooProductView[] | WooProductView {
  if (request.operation === "products.retrieve") return productView(response);
  if (!Array.isArray(response) || response.length > request.maxItems) throw new WooProductResponseError();
  return response.map(productView);
}
