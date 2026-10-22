import type { IncomingMessage } from "node:http";
import { readBoundedBody } from "../../http/body.js";
import { decodeNonDuplicateJson } from "../../merchant/conversations/messages/request.js";
import { singleHeader } from "../../http/headers.js";
import { hasRequestBody } from "../../merchant/support/request.js";
import { MAX_WOO_RECOVERY_SELECTION_BYTES, parseCanonicalPhone,
  parseWooRecoverySelectionChange, WooRecoverySelectionError, WP_ADMIN_VERIFIED_HEADER } from "./contract.js";

export function requireWooAdminAttestation(request: IncomingMessage): void {
  const admin = singleHeader(request, WP_ADMIN_VERIFIED_HEADER);
  if (admin.count !== 1 || admin.value !== "1") {
    throw new WooRecoverySelectionError(403, "admin_authorization_required");
  }
}

export function readWooRecoverySelectionQuery(request: IncomingMessage, url: URL): string {
  if ((request.url?.length ?? 0) > 256 || hasRequestBody(request) ||
    [...url.searchParams.keys()].length !== 1 || !url.searchParams.has("canonicalPhone")) {
    throw new WooRecoverySelectionError(400, "invalid_request");
  }
  return parseCanonicalPhone(url.searchParams.get("canonicalPhone"));
}

export async function readWooRecoverySelectionChange(request: IncomingMessage) {
  const type = singleHeader(request, "content-type");
  const encoding = singleHeader(request, "content-encoding");
  const length = singleHeader(request, "content-length");
  if (type.count !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type.value ?? "") ||
    encoding.count > 1 || (encoding.count === 1 && encoding.value?.toLowerCase() !== "identity") ||
    length.count > 1 || (length.count === 1 && !/^\d+$/.test(length.value ?? ""))) {
    throw new WooRecoverySelectionError(400, "invalid_request");
  }
  if (length.value && Number(length.value) > MAX_WOO_RECOVERY_SELECTION_BYTES) {
    throw new WooRecoverySelectionError(413, "request_too_large");
  }
  const bytes = await readBoundedBody(request, MAX_WOO_RECOVERY_SELECTION_BYTES, reason =>
    new WooRecoverySelectionError(reason === "oversized" ? 413 : 400,
      reason === "oversized" ? "request_too_large" : "invalid_request"));
  if (!bytes.length) throw new WooRecoverySelectionError(400, "invalid_request");
  try { return parseWooRecoverySelectionChange(decodeNonDuplicateJson(bytes)); }
  catch (error) {
    if (error instanceof WooRecoverySelectionError) throw error;
    throw new WooRecoverySelectionError(400, "invalid_request");
  }
}
