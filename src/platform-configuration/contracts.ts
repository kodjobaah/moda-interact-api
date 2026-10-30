import { Buffer } from "node:buffer";
import {
  type CredentialEnvelope,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import { configurationError, type ApiConfigurationKey } from "./errors.js";
import { assertApiDeploymentEnvironment } from "./repository.js";

export interface MerchantKnowledgeUploadPolicy {
  maxUploadBytes: number;
  maxXlsxUncompressedBytes: number;
  r2Endpoint: string;
  r2Bucket: string;
}

/** Only trusted API code may receive R2 credentials. Never return from a public route. */
export interface MerchantKnowledgeR2Configuration extends MerchantKnowledgeUploadPolicy {
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
}

const UPLOAD_HARD_CAP_BYTES = 25 * 1024 * 1024;
const XLSX_HARD_CAP_BYTES = 100 * 1024 * 1024;
const SEALED_FIELDS = ["kind", "schemaVersion", "algorithm", "wrappingKeyId", "nonce", "ciphertext", "authTag"];
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isClosedObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

export function requiredSecret(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max &&
    value.trim().length > 0 && !value.includes("\u0000");
}

/** ADMIN-002 write contract: the six sealed plaintext properties are
 * endpoint, bucket, accessKeyId, secretAccessKey, maxUploadBytes and
 * maxXlsxUncompressedBytes. They are NOT the outward API projection names.
 * Plaintext policies and legacy key aliases are never accepted.
 */
export function decodeMerchantKnowledgeR2Configuration(value: unknown): MerchantKnowledgeR2Configuration {
  const key = "merchant.knowledge.r2";
  if (!isClosedObject(value, ["endpoint", "bucket", "accessKeyId", "secretAccessKey", "maxUploadBytes", "maxXlsxUncompressedBytes"])) {
    configurationError(key, "INVALID_VALUE");
  }
  if (!Number.isSafeInteger(value.maxUploadBytes) || (value.maxUploadBytes as number) < 1 ||
      (value.maxUploadBytes as number) > UPLOAD_HARD_CAP_BYTES ||
      !Number.isSafeInteger(value.maxXlsxUncompressedBytes) || (value.maxXlsxUncompressedBytes as number) < 1 ||
      (value.maxXlsxUncompressedBytes as number) > XLSX_HARD_CAP_BYTES ||
      typeof value.endpoint !== "string" || value.endpoint.length > 2048 ||
      typeof value.bucket !== "string" || !/^[A-Za-z0-9._-]{3,63}$/.test(value.bucket) ||
      !requiredSecret(value.accessKeyId, 1, 256) ||
      !requiredSecret(value.secretAccessKey, 1, 1024)) {
    configurationError(key, "INVALID_VALUE");
  }
  let endpoint: URL;
  try { endpoint = new URL(value.endpoint); }
  catch (error) { return configurationError(key, "INVALID_VALUE", error); }
  // Preserve the existing API's Cloudflare R2 allowlist and SSRF controls.
  if (endpoint.protocol !== "https:" || endpoint.port || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
      !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(endpoint.hostname)) {
    configurationError(key, "INVALID_VALUE");
  }
  return Object.freeze({
    maxUploadBytes: value.maxUploadBytes as number,
    maxXlsxUncompressedBytes: value.maxXlsxUncompressedBytes as number,
    r2Endpoint: endpoint.toString(), r2Bucket: value.bucket as string,
    r2AccessKeyId: value.accessKeyId as string,
    r2SecretAccessKey: value.secretAccessKey as string,
  });
}

function canonicalBytes(value: unknown, min: number, max: number): Uint8Array | null {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < min || bytes.length > max || bytes.toString("base64") !== value) return null;
  return Uint8Array.from(bytes);
}

export function isDisabledPlatformSecret(value: unknown): boolean {
  return isClosedObject(value, ["kind", "schemaVersion"]) &&
    value.kind === "disabled" && value.schemaVersion === 1;
}

export function decodePlatformSecretEnvelope(key: ApiConfigurationKey, value: unknown): CredentialEnvelope {
  if (!isClosedObject(value, SEALED_FIELDS) || value.kind !== "sealed" ||
      value.schemaVersion !== 1 || value.algorithm !== "AES-256-GCM" ||
      typeof value.wrappingKeyId !== "string" || !KEY_ID_PATTERN.test(value.wrappingKeyId) ||
      ["__proto__", "prototype", "constructor"].includes(value.wrappingKeyId)) {
    configurationError(key, "INVALID_ENVELOPE");
  }
  const nonce = canonicalBytes(value.nonce, 12, 12);
  const ciphertext = canonicalBytes(value.ciphertext, 1, 8192);
  const authTag = canonicalBytes(value.authTag, 16, 16);
  if (!nonce || !ciphertext || !authTag) configurationError(key, "INVALID_ENVELOPE");
  return { keyId: value.wrappingKeyId as string, nonce, ciphertext, authTag };
}

/** Frozen byte-identical AAD. This is NOT the AAD of persisted Woo grants. */
export function apiPlatformConfigurationAad(
  environment: string, key: ApiConfigurationKey, version: number,
): string {
  assertApiDeploymentEnvironment(environment, key);
  if (!Number.isSafeInteger(version) || version < 1 || version > 2147483647) {
    configurationError(key, "INVALID_ROW");
  }
  return JSON.stringify(["moda-platform-config-v1", environment, key, version, 1]);
}
