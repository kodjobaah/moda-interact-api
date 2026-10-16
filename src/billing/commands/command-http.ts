import type { IncomingMessage, ServerResponse } from "node:http";
import { readBoundedBody, decodeStrictJsonBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { sendNoStoreJson as sendJson } from "../../http/response.js";

export { singleHeader } from "../../http/headers.js";
export { sendNoStoreJson as sendJson } from "../../http/response.js";

// Preserve the command request limits and strict decoding from the pre-extraction Woo router.
const MAX_COMMAND_BODY_BYTES = 8192;

export class HttpFailure extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
    this.name = "HttpFailure";
  }
}

export async function parseRecurringPlanRequest(request: IncomingMessage): Promise<string> {
  const contentType = singleHeader(request, "content-type");
  const contentEncoding = singleHeader(request, "content-encoding");
  const contentLength = singleHeader(request, "content-length");
  if (
    contentType.count !== 1 ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    contentEncoding.count > 1 ||
    (contentEncoding.count === 1 && contentEncoding.value?.toLowerCase() !== "identity") ||
    contentLength.count > 1 ||
    (contentLength.count === 1 && !/^\d+$/.test(contentLength.value ?? ""))
  ) throw new HttpFailure(400, "invalid_request");

  const bytes = await readBoundedBody(request, MAX_COMMAND_BODY_BYTES, (reason) => reason === "oversized"
    ? new HttpFailure(413, "request_too_large")
    : new HttpFailure(400, "invalid_request"));
  let value: unknown;
  try {
    value = decodeStrictJsonBody(bytes);
  } catch {
    throw new HttpFailure(400, "invalid_request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpFailure(400, "invalid_request");
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 1 || Object.keys(body)[0] !== "merchantPricingPlanId" ||
    typeof body.merchantPricingPlanId !== "string" || body.merchantPricingPlanId.length < 1 ||
    body.merchantPricingPlanId.length > 128
  ) throw new HttpFailure(400, "invalid_request");
  return body.merchantPricingPlanId;
}

export async function parseRecoveryCreditPurchaseRequest(request: IncomingMessage): Promise<string> {
  const contentType = singleHeader(request, "content-type");
  const contentEncoding = singleHeader(request, "content-encoding");
  const contentLength = singleHeader(request, "content-length");
  if (
    contentType.count !== 1 ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    contentEncoding.count > 1 ||
    (contentEncoding.count === 1 && contentEncoding.value?.toLowerCase() !== "identity") ||
    contentLength.count > 1 ||
    (contentLength.count === 1 && !/^\d+$/.test(contentLength.value ?? ""))
  ) throw new HttpFailure(400, "invalid_request");

  const bytes = await readBoundedBody(request, MAX_COMMAND_BODY_BYTES, (reason) => reason === "oversized"
    ? new HttpFailure(413, "request_too_large")
    : new HttpFailure(400, "invalid_request"));
  let value: unknown;
  try {
    value = decodeStrictJsonBody(bytes);
  } catch {
    throw new HttpFailure(400, "invalid_request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpFailure(400, "invalid_request");
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 1 || Object.keys(body)[0] !== "merchantPricingUsageEventId" ||
    typeof body.merchantPricingUsageEventId !== "string" ||
    body.merchantPricingUsageEventId.length < 1 || body.merchantPricingUsageEventId.length > 128
  ) throw new HttpFailure(400, "invalid_request");
  return body.merchantPricingUsageEventId;
}

export function requestHasBody(request: IncomingMessage): boolean {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    const value = request.rawHeaders[index + 1];
    if (name === "transfer-encoding") return true;
    if (name === "content-length" && value !== undefined && (!/^\d+$/.test(value) || Number(value) > 0)) return true;
  }
  return false;
}

export function sendError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  operationId?: string,
  safeProviderCode?: string,
  purchaseId?: string,
): void {
  sendJson(response, statusCode, {
    error: code,
    ...(operationId ? { operationId } : {}),
    ...(safeProviderCode ? { providerErrorCode: safeProviderCode } : {}),
    ...(purchaseId ? { purchaseId } : {}),
  });
}
