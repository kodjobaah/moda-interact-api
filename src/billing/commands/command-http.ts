import type { IncomingMessage, ServerResponse } from "node:http";

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

  const bytes = await readBoundedBody(request);
  let value: unknown;
  try {
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bodyText.includes("\0")) throw new Error("nul");
    value = JSON.parse(bodyText);
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

  const bytes = await readBoundedBody(request);
  let value: unknown;
  try {
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bodyText.includes("\0")) throw new Error("nul");
    value = JSON.parse(bodyText);
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

function readBoundedBody(request: IncomingMessage, maximumBytes = MAX_COMMAND_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAbort);
      request.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximumBytes) {
        cleanup();
        request.resume();
        reject(new HttpFailure(413, "request_too_large"));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onAbort = () => {
      cleanup();
      reject(new HttpFailure(400, "invalid_request"));
    };
    const onError = () => {
      cleanup();
      reject(new HttpFailure(400, "invalid_request"));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onError);
  });
}

export function singleHeader(request: IncomingMessage, name: string): { count: number; value?: string } {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  const value = values[0];
  return values.length === 1 && value !== undefined
    ? { count: 1, value }
    : { count: values.length };
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

export function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}