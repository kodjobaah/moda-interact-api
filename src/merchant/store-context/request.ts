import type { IncomingMessage } from "node:http";
import { readBoundedBody, decodeStrictJsonBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { isMerchantStoreContextSnapshot, type MerchantStoreContextSnapshot } from "./schema.js";

/** The store-context body limit is intentionally distinct from connection bootstrap. */
export const MAX_STORE_CONTEXT_BODY_BYTES = 2048;

export class StoreContextHttpFailure extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
    this.name = "StoreContextHttpFailure";
  }
}

export async function parseStoreContextRequest(request: IncomingMessage): Promise<MerchantStoreContextSnapshot> {
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
  ) throw new StoreContextHttpFailure(400, "invalid_request");
  if (contentLength.value && Number(contentLength.value) > MAX_STORE_CONTEXT_BODY_BYTES) {
    throw new StoreContextHttpFailure(413, "request_too_large");
  }
  const bytes = await readBoundedBody(request, MAX_STORE_CONTEXT_BODY_BYTES, (reason) => reason === "oversized"
    ? new StoreContextHttpFailure(413, "request_too_large")
    : new StoreContextHttpFailure(400, "invalid_request"));
  let body: unknown;
  try {
    body = decodeStrictJsonBody(bytes);
  } catch {
    throw new StoreContextHttpFailure(400, "invalid_request");
  }
  if (!isMerchantStoreContextSnapshot(body)) throw new StoreContextHttpFailure(400, "invalid_request");
  return body;
}
