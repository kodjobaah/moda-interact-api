import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Test-only independent SigV4 verifier for the signed browser PUT fixture.
 * The fixture is not a replacement for Cloudflare R2 or a browser's CORS engine.
 * The local HTTP server maps the signed R2 hostname to localhost; this verifier
 * deliberately uses the original signed hostname when rebuilding the request.
 */
function encode(input: string): string {
  return encodeURIComponent(input).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
function hmac(key: Uint8Array | string, input: string): Buffer {
  return createHmac("sha256", key).update(input).digest();
}
function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
function signingTime(value: string): number {
  if (!/^\d{8}T\d{6}Z$/.test(value)) return NaN;
  return Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T` +
    `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
}

export function verifyPresignedBrowserPut(input: {
  signedUrl: string;
  requestHeaders: Headers;
  secretAccessKey: string;
  accessKeyId: string;
  at: Date;
}): boolean {
  const { requestHeaders, accessKeyId, secretAccessKey, at } = input;
  let url: URL;
  try { url = new URL(input.signedUrl); }
  catch { return false; }
  const params = url.searchParams;
  const algorithm = params.get("X-Amz-Algorithm");
  const date = params.get("X-Amz-Date") ?? "";
  const expiry = Number(params.get("X-Amz-Expires"));
  const credential = params.get("X-Amz-Credential") ?? "";
  const signedHeaders = params.get("X-Amz-SignedHeaders") ?? "";
  const signature = params.get("X-Amz-Signature") ?? "";
  const scope = credential.slice(accessKeyId.length + 1);
  const scopeParts = scope.split("/");
  const signedAt = signingTime(date);
  if (url.protocol !== "https:" || url.port || !url.hostname.endsWith(".r2.cloudflarestorage.com") ||
      algorithm !== "AWS4-HMAC-SHA256" || !credential.startsWith(`${accessKeyId}/`) ||
      scopeParts.length !== 4 || scopeParts[0] !== date.slice(0, 8) ||
      scopeParts[1] !== "auto" || scopeParts[2] !== "s3" || scopeParts[3] !== "aws4_request" ||
      !Number.isSafeInteger(expiry) || expiry < 1 || expiry > 600 ||
      !Number.isFinite(signedAt) || at.getTime() < signedAt - 5 * 60_000 ||
      at.getTime() >= signedAt + expiry * 1000 || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const names = signedHeaders.split(";");
  if (names.join(";") !== "content-type;host;if-none-match;x-amz-meta-sha256") return false;

  const canonicalHeaders = names.map((name) => {
    const value = name === "host" ? url.host : requestHeaders.get(name);
    if (value === null || !value.trim()) return null;
    return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
  });
  if (canonicalHeaders.some((line) => line === null)) return false;
  const canonicalQuery = [...params.entries()]
    .filter(([key]) => key !== "X-Amz-Signature")
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? (aValue < bValue ? -1 : aValue > bValue ? 1 : 0) : (aKey < bKey ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`).join("&");
  const payloadHash = params.get("X-Amz-Content-Sha256") ?? "UNSIGNED-PAYLOAD";
  const canonical = ["PUT", url.pathname, canonicalQuery, canonicalHeaders.join(""), signedHeaders, payloadHash].join("\n");
  const toSign = [algorithm, date, scope, sha(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, scopeParts[0]!), scopeParts[1]!), scopeParts[2]!), "aws4_request");
  const calculated = hmac(key, toSign);
  return timingSafeEqual(calculated, Buffer.from(signature, "hex"));
}
