import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWooWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  apiSecret: string,
): boolean {
  const signature = signatureHeader.replace(/^[\t ]+|[\t ]+$/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signature)) {
    return false;
  }

  const suppliedDigest = Buffer.from(signature, "base64");
  if (suppliedDigest.length !== 32 || suppliedDigest.toString("base64") !== signature) {
    return false;
  }
  const expectedDigest = createHmac("sha256", Buffer.from(apiSecret, "utf8")).update(rawBody).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}