import type { IncomingMessage } from "node:http";
import { decodeStrictJsonBody, readBoundedBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import {
  FeaturePreferencesRequestError, MAX_FEATURE_PREFERENCE_BODY_BYTES,
  parseFeaturePreferencesUpdate,
} from "./contract.js";

export function hasFeaturePreferencesBody(request: IncomingMessage): boolean {
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]?.toLowerCase();
    const value = request.rawHeaders[i + 1];
    if (name === "transfer-encoding" || (name === "content-length" && (!value || !/^0+$/.test(value)))) return true;
  }
  return false;
}

export async function readFeaturePreferencesUpdate(request: IncomingMessage) {
  const contentType = singleHeader(request, "content-type");
  const contentEncoding = singleHeader(request, "content-encoding");
  const contentLength = singleHeader(request, "content-length");
  if (contentType.count !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    contentEncoding.count > 1 || (contentEncoding.count === 1 && contentEncoding.value?.toLowerCase() !== "identity") ||
    contentLength.count > 1 || (contentLength.count === 1 && !/^\d+$/.test(contentLength.value ?? ""))) {
    throw new FeaturePreferencesRequestError(400, "invalid_request");
  }
  if (contentLength.value && Number(contentLength.value) > MAX_FEATURE_PREFERENCE_BODY_BYTES) {
    throw new FeaturePreferencesRequestError(413, "request_too_large");
  }
  const bytes = await readBoundedBody(request, MAX_FEATURE_PREFERENCE_BODY_BYTES,
    (reason) => new FeaturePreferencesRequestError(reason === "oversized" ? 413 : 400,
      reason === "oversized" ? "request_too_large" : "invalid_request"));
  if (bytes.length === 0) throw new FeaturePreferencesRequestError(400, "invalid_request");
  try { return parseFeaturePreferencesUpdate(decodeStrictJsonBody(bytes)); }
  catch (error) {
    if (error instanceof FeaturePreferencesRequestError) throw error;
    throw new FeaturePreferencesRequestError(400, "invalid_request");
  }
}
