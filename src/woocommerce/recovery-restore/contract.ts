import {
  WooRestoreResolveRequestV1Schema,
  type WooRestoreResolveRequestV1,
} from "@modainteract/moda-interact-shared/woocommerce";
import { decodeStrictJsonBody, readBoundedBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";

export const WOO_RESTORE_RESOLVE_PATH = "/v1/woocommerce/recovery-restore/resolve";
export const MAX_WOO_RESTORE_RESOLVE_BODY_BYTES = 4096;

export class WooRestoreResolveRequestError extends Error {
  constructor() {
    super("invalid_request");
    this.name = "WooRestoreResolveRequestError";
  }
}

export async function readWooRestoreResolveRequest(
  request: Parameters<typeof readBoundedBody>[0],
): Promise<WooRestoreResolveRequestV1> {
  const contentType = singleHeader(request, "content-type");
  const contentEncoding = singleHeader(request, "content-encoding");
  const contentLength = singleHeader(request, "content-length");
  if (
    contentType.count !== 1 ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    contentEncoding.count > 1 ||
    (contentEncoding.count === 1 && contentEncoding.value?.toLowerCase() !== "identity") ||
    contentLength.count > 1 ||
    (contentLength.count === 1 && !/^\d+$/.test(contentLength.value ?? "")) ||
    (contentLength.count === 1 && Number(contentLength.value) > MAX_WOO_RESTORE_RESOLVE_BODY_BYTES)
  ) {
    throw new WooRestoreResolveRequestError();
  }

  let bytes: Buffer;
  try {
    bytes = await readBoundedBody(request, MAX_WOO_RESTORE_RESOLVE_BODY_BYTES, () =>
      new WooRestoreResolveRequestError());
  } catch {
    throw new WooRestoreResolveRequestError();
  }

  let value: unknown;
  try {
    value = decodeStrictJsonBody(bytes);
  } catch {
    throw new WooRestoreResolveRequestError();
  }
  const parsed = WooRestoreResolveRequestV1Schema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(parsed.data.recoveryId, "utf8") > 128 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.data.recoveryId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.data.token)) {
    throw new WooRestoreResolveRequestError();
  }
  return parsed.data;
}