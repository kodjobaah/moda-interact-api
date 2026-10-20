import type { IncomingMessage } from "node:http";
import { readBoundedBody, decodeStrictJsonBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { MAX_WOO_ACTIVITY_BYTES, parseWooCheckoutEvent, WooActivityRequestError } from "./contract.js";

/** Authenticate before reading any event bytes; disallow compressed/ambiguous content. */
export async function readWooCheckoutRequest(request: IncomingMessage) {
  const type = singleHeader(request, "content-type");
  const encoding = singleHeader(request, "content-encoding");
  const length = singleHeader(request, "content-length");
  if (type.count !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type.value ?? "") ||
      encoding.count > 1 || (encoding.count === 1 && encoding.value?.toLowerCase() !== "identity") ||
      length.count > 1 || (length.count === 1 && !/^\d+$/.test(length.value ?? ""))) {
    throw new WooActivityRequestError(400, "invalid_request");
  }
  if (length.value && Number(length.value) > MAX_WOO_ACTIVITY_BYTES) {
    throw new WooActivityRequestError(413, "request_too_large");
  }
  const bytes = await readBoundedBody(request, MAX_WOO_ACTIVITY_BYTES,
    (reason) => new WooActivityRequestError(reason === "oversized" ? 413 : 400,
      reason === "oversized" ? "request_too_large" : "invalid_request"));
  if (bytes.length === 0) throw new WooActivityRequestError(400, "invalid_request");
  try { return parseWooCheckoutEvent(decodeStrictJsonBody(bytes)); }
  catch (error) {
    if (error instanceof WooActivityRequestError) throw error;
    throw new WooActivityRequestError(400, "invalid_request");
  }
}
