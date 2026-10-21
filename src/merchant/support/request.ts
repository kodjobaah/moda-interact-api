import type { IncomingMessage } from "node:http";
import { decodeNonDuplicateJson } from "../conversations/messages/request.js";
import { readBoundedBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { MAX_SUPPORT_BODY_BYTES, parseSupportCompose, SupportRequestError } from "./contract.js";

/** Reuse the existing strict JSON duplicate-key guard and bounded HTTP body reader. */
export async function readSupportCompose(request: IncomingMessage) {
  const contentType = singleHeader(request,"content-type");
  const encoding = singleHeader(request,"content-encoding");
  const length = singleHeader(request,"content-length");
  if (contentType.count !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    encoding.count > 1 || (encoding.count === 1 && encoding.value?.toLowerCase() !== "identity") ||
    length.count > 1 || (length.count === 1 && !/^\d+$/.test(length.value ?? ""))) {
    throw new SupportRequestError(400,"invalid_request");
  }
  if (length.value && Number(length.value) > MAX_SUPPORT_BODY_BYTES) throw new SupportRequestError(413,"request_too_large");
  const bytes = await readBoundedBody(request, MAX_SUPPORT_BODY_BYTES, reason =>
    new SupportRequestError(reason === "oversized" ? 413 : 400, reason === "oversized" ? "request_too_large" : "invalid_request"));
  if (!bytes.length) throw new SupportRequestError(400,"invalid_request");
  try { return parseSupportCompose(decodeNonDuplicateJson(bytes)); }
  catch (error) {
    if (error instanceof SupportRequestError) throw error;
    throw new SupportRequestError(400,"invalid_request");
  }
}
export function hasRequestBody(request: IncomingMessage) {
  for (let i=0; i<request.rawHeaders.length; i+=2) {
    const key = request.rawHeaders[i]?.toLowerCase(), value = request.rawHeaders[i+1];
    if (key === "transfer-encoding" || key === "content-length" && (value === undefined || !/^0+$/.test(value))) return true;
  }
  return false;
}
