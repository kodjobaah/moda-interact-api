import type { IncomingMessage } from "node:http";
import { MAX_RECOVERY_POLICY_BODY_BYTES, RecoveryPolicyRequestError, parseRecoveryPolicyUpdate } from "./contract.js";

/** Reject query bodies/tenant IDs, oversized JSON and extra mutation fields before service execution. */
export async function readRecoveryPolicyUpdate(request: IncomingMessage) {
  const contentTypes = request.rawHeaders.flatMap((name, index, all) =>
    index % 2 === 0 && name.toLowerCase() === "content-type" ? [all[index + 1] ?? ""] : []);
  if (contentTypes.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentTypes[0] ?? "")) {
    throw new RecoveryPolicyRequestError(400, "invalid_request");
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > MAX_RECOVERY_POLICY_BODY_BYTES) throw new RecoveryPolicyRequestError(413, "request_too_large");
      chunks.push(buffer);
    }
    if (bytes === 0) throw new RecoveryPolicyRequestError(400, "invalid_request");
    return parseRecoveryPolicyUpdate(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof RecoveryPolicyRequestError) throw error;
    throw new RecoveryPolicyRequestError(400, "invalid_request");
  }
}

export function requestHasBody(request: IncomingMessage): boolean {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    const value = request.rawHeaders[index + 1];
    if (name === "transfer-encoding") return true;
    if (name === "content-length" && (value === undefined || !/^0+$/.test(value))) return true;
  }
  return false;
}
