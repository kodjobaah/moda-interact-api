import type { IncomingMessage } from "node:http";
import { decodeStrictJsonBody, readBoundedBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { categoryPresentationLocale, StoreCategoryReadError } from "../store-categories/locale.js";
import {
  MAX_PROMOTION_BODY_BYTES, MAX_PROMOTION_PAGE, PromotionRequestError, parsePromotionSelection,
} from "./contract.js";
import type { PromotionReadOptions } from "./read.js";

export function readPromotionsQuery(params: URLSearchParams): PromotionReadOptions {
  if ([...params.keys()].some((key) => !["offerPage", "historyPage", "locale"].includes(key)) ||
    ["offerPage", "historyPage", "locale"].some((key) => params.getAll(key).length > 1)) {
    throw new PromotionRequestError(400, "invalid_request");
  }
  const page = (key: string) => {
    const raw = params.get(key);
    if (raw === null) return 1;
    if (!/^[1-9]\d{0,3}$/.test(raw) || Number(raw) > MAX_PROMOTION_PAGE) {
      throw new PromotionRequestError(400, "invalid_request");
    }
    return Number(raw);
  };
  try {
    const locale = categoryPresentationLocale(params.get("locale") ?? undefined);
    return { offerPage: page("offerPage"), historyPage: page("historyPage"), locale: locale.resolvedLocale };
  } catch (error) {
    if (error instanceof StoreCategoryReadError) throw new PromotionRequestError(400, "invalid_request");
    throw error;
  }
}

export function hasPromotionBody(request: IncomingMessage): boolean {
  return request.rawHeaders.some((name, index) => index % 2 === 0 && (
    name.toLowerCase() === "transfer-encoding" ||
    (name.toLowerCase() === "content-length" && !/^0+$/.test(request.rawHeaders[index + 1] ?? ""))));
}

export async function readPromotionSelectionRequest(request: IncomingMessage) {
  const contentType = singleHeader(request, "content-type");
  const contentEncoding = singleHeader(request, "content-encoding");
  const contentLength = singleHeader(request, "content-length");
  if (contentType.count !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    contentEncoding.count > 1 || (contentEncoding.count === 1 && contentEncoding.value?.toLowerCase() !== "identity") ||
    contentLength.count > 1 || (contentLength.count === 1 && !/^\d+$/.test(contentLength.value ?? ""))) {
    throw new PromotionRequestError(400, "invalid_request");
  }
  if (contentLength.value && Number(contentLength.value) > MAX_PROMOTION_BODY_BYTES) {
    throw new PromotionRequestError(413, "request_too_large");
  }
  const bytes = await readBoundedBody(request, MAX_PROMOTION_BODY_BYTES,
    (reason) => new PromotionRequestError(reason === "oversized" ? 413 : 400,
      reason === "oversized" ? "request_too_large" : "invalid_request"));
  if (!bytes.length) throw new PromotionRequestError(400, "invalid_request");
  try { return parsePromotionSelection(decodeStrictJsonBody(bytes)); }
  catch (error) {
    if (error instanceof PromotionRequestError) throw error;
    throw new PromotionRequestError(400, "invalid_request");
  }
}
