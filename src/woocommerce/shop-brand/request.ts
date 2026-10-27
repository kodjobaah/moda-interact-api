import type { IncomingMessage } from "node:http";
import { readBoundedBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { decodeNonDuplicateJson } from "../../merchant/conversations/messages/request.js";
import { MAX_WOO_SHOP_BRAND_BYTES, parseWooShopBrandSnapshot, WooShopBrandHttpError } from "./contract.js";

/** Only callable AFTER the existing Woo installation authenticator succeeds. */
export async function readWooShopBrandRequest(request: IncomingMessage) {
  // Do not allow ambiguously duplicated headers, including auth and transfer
  // headers. Node's normalised headers discard that distinction.
  const headers = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]?.toLowerCase();
    if (!name || headers.has(name)) throw new WooShopBrandHttpError(400, "invalid_request");
    headers.add(name);
  }
  const type = singleHeader(request, "content-type");
  const encoding = singleHeader(request, "content-encoding");
  const length = singleHeader(request, "content-length");
  const transfer = singleHeader(request, "transfer-encoding");
  if (type.count !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type.value ?? "") ||
    encoding.count > 1 || (encoding.count === 1 && encoding.value?.toLowerCase() !== "identity") ||
    length.count > 1 || (length.count === 1 && !/^\d+$/.test(length.value ?? "")) ||
    (length.count > 0 && transfer.count > 0)) {
    throw new WooShopBrandHttpError(400, "invalid_request");
  }
  if (length.value && Number(length.value) > MAX_WOO_SHOP_BRAND_BYTES) {
    throw new WooShopBrandHttpError(413, "request_too_large");
  }
  const body = await readBoundedBody(request, MAX_WOO_SHOP_BRAND_BYTES, reason =>
    new WooShopBrandHttpError(reason === "oversized" ? 413 : 400,
      reason === "oversized" ? "request_too_large" : "invalid_request"));
  if (!body.length) throw new WooShopBrandHttpError(400, "invalid_request");
  try { return parseWooShopBrandSnapshot(decodeNonDuplicateJson(body)); }
  catch (error) {
    if (error instanceof WooShopBrandHttpError) throw error;
    throw new WooShopBrandHttpError(400, "invalid_request");
  }
}
