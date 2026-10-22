import type { IncomingMessage } from "node:http";
import { readBoundedBody, decodeStrictJsonBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { MAX_WOO_CONSENT_BYTES, parseWooConsentEvent, WooConsentHttpError } from "./contract.js";

/** Authenticate before reading the body; limit decoded data and reject duplicate headers. */
export async function readWooConsentRequest(request: IncomingMessage) {
  const type = singleHeader(request, "content-type");
  const encoding = singleHeader(request, "content-encoding");
  const length = singleHeader(request, "content-length");
  if (type.count !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type.value ?? "") ||
    encoding.count > 1 || (encoding.count === 1 && encoding.value?.toLowerCase() !== "identity") ||
    length.count > 1 || (length.count === 1 && !/^\d+$/.test(length.value ?? ""))) {
    throw new WooConsentHttpError(400, "invalid_request");
  }
  if (length.value && Number(length.value) > MAX_WOO_CONSENT_BYTES) {
    throw new WooConsentHttpError(413, "request_too_large");
  }
  const bytes = await readBoundedBody(request, MAX_WOO_CONSENT_BYTES, reason =>
    new WooConsentHttpError(reason === "oversized" ? 413 : 400,
      reason === "oversized" ? "request_too_large" : "invalid_request"));
  if (!bytes.length) throw new WooConsentHttpError(400, "invalid_request");
  try { return parseWooConsentEvent(decodeStrictJsonBody(bytes)); }
  catch (error) {
    if (error instanceof WooConsentHttpError) throw error;
    throw new WooConsentHttpError(400, "invalid_request");
  }
}
