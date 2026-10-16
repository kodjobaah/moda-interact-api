import type { IncomingMessage } from "node:http";
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
  const bytes = await readBoundedBody(request, MAX_STORE_CONTEXT_BODY_BYTES);
  let body: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("nul");
    body = JSON.parse(text);
  } catch {
    throw new StoreContextHttpFailure(400, "invalid_request");
  }
  if (!isMerchantStoreContextSnapshot(body)) throw new StoreContextHttpFailure(400, "invalid_request");
  return body;
}

function readBoundedBody(request: IncomingMessage, maximumBytes = MAX_STORE_CONTEXT_BODY_BYTES): Promise<Buffer> {
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
        reject(new StoreContextHttpFailure(413, "request_too_large"));
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
      reject(new StoreContextHttpFailure(400, "invalid_request"));
    };
    const onError = () => {
      cleanup();
      reject(new StoreContextHttpFailure(400, "invalid_request"));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onError);
  });
}

function singleHeader(request: IncomingMessage, name: string): { count: number; value?: string } {
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
