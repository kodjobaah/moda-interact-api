import { createHmac } from "node:crypto";
import { constantTimeDigestMatches, decodeSecret } from "../../auth/woo-installation/credential.js";

export function createSiteProof(
  bootstrapSecret: Uint8Array,
  attemptId: string,
  nonce: string,
  canonicalSiteUrl: string,
): string {
  const message = `moda-interact-connect-v1\n${attemptId}\n${nonce}\n${canonicalSiteUrl}`;
  return createHmac("sha256", bootstrapSecret).update(message, "utf8").digest("base64url");
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