import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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

export function createSiteProof(
  bootstrapSecret: Uint8Array,
  attemptId: string,
  nonce: string,
  canonicalSiteUrl: string,
): string {
  const message = `moda-interact-connect-v1\n${attemptId}\n${nonce}\n${canonicalSiteUrl}`;
  return createHmac("sha256", bootstrapSecret).update(message, "utf8").digest("base64url");
}

export function constantTimeDigestMatches(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return left.byteLength === CREDENTIAL_BYTES &&
    right.byteLength === CREDENTIAL_BYTES &&
    timingSafeEqual(left, right);
}

export function verifySiteProof(
  bootstrapSecret: Uint8Array,
  attemptId: string,
  nonce: string,
  canonicalSiteUrl: string,
  encodedProof: string,
): boolean {
  const proof = decodeSecret(encodedProof);
  if (!proof) return false;
  const expected = Buffer.from(
    createSiteProof(bootstrapSecret, attemptId, nonce, canonicalSiteUrl),
    "base64url",
  );
  return constantTimeDigestMatches(expected, proof);
}