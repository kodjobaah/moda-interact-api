import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CREDENTIAL_BYTES = 32;

export function randomSecret(): Buffer {
  return randomBytes(CREDENTIAL_BYTES);
}

export function encodeSecret(secret: Uint8Array): string {
  return Buffer.from(secret).toString("base64url");
}

export function decodeSecret(encoded: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== CREDENTIAL_BYTES || decoded.toString("base64url") !== encoded) {
    return undefined;
  }
  return decoded;
}

export function digestSecret(secret: Uint8Array): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function constantTimeDigestMatches(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return left.byteLength === CREDENTIAL_BYTES &&
    right.byteLength === CREDENTIAL_BYTES &&
    timingSafeEqual(left, right);
}
