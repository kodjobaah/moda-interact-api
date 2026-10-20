import { createHash } from "node:crypto";
import { MerchantKnowledgeDataFormatKeySchema, MerchantKnowledgePurposeKeySchema } from "@modainteract/moda-interact-shared/merchant-knowledge";
import { ModaSupportedLanguageTagSchema } from "@modainteract/moda-interact-shared/internationalization";

export const KNOWLEDGE_UPLOAD_INTENTS_PATH = "/v1/merchant/merchant-knowledge/upload-intents";
export const KNOWLEDGE_UPLOAD_FINALIZE_PATH = "/v1/merchant/merchant-knowledge/upload-finalize";
export const KNOWLEDGE_UPLOAD_ROUTE = /^\/v1\/merchant\/merchant-knowledge\/uploads\/([A-Za-z0-9_-]{1,128})(\/reprocess)?$/;
export const UPLOAD_TTL_SECONDS = 600;
export const UPLOAD_REQUEST_MAX_BYTES = 4096;
export type UploadFormat = "CSV" | "XLSX";

export class KnowledgeUploadError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
    readonly code: "invalid_request" | "request_too_large" | "knowledge_upload_denied" | "knowledge_upload_conflict" |
      "knowledge_upload_expired" | "knowledge_upload_not_found" | "knowledge_upload_integrity_mismatch" | "knowledge_upload_unavailable") {
    super(code);
  }
}
export const invalid = () => new KnowledgeUploadError(400, "invalid_request");
export const denied = () => new KnowledgeUploadError(403, "knowledge_upload_denied");
export const conflict = () => new KnowledgeUploadError(409, "knowledge_upload_conflict");
export const unavailable = () => new KnowledgeUploadError(503, "knowledge_upload_unavailable");
export const integrity = () => new KnowledgeUploadError(409, "knowledge_upload_integrity_mismatch");

function exactObject(input: unknown, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const object = input as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key)) || required.some((key) => !Object.hasOwn(object, key))) throw invalid();
  return object;
}
function str(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      [...value].some((character) => character.charCodeAt(0) < 32)) throw invalid();
  return value.trim();
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid();
  return value;
}
function positiveSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}
function purpose(value: unknown): string {
  const result = MerchantKnowledgePurposeKeySchema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
function format(value: unknown): UploadFormat {
  const result = MerchantKnowledgeDataFormatKeySchema.safeParse(value);
  if (!result.success || (result.data !== "CSV" && result.data !== "XLSX")) throw invalid();
  return result.data;
}
function language(value: unknown): string {
  const result = ModaSupportedLanguageTagSchema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
export function safeId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw invalid();
  return value;
}
function mime(value: unknown): string {
  const parsed = str(value, 128).toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(parsed)) throw invalid();
  return parsed;
}
export interface UploadIntentRequest {
  idempotencyKey: string; purposeKey: string; dataFormatKey: UploadFormat;
  originalFileName: string; contentType: string; sizeBytes: number; sha256: string;
}
export function parseIntent(input: unknown): UploadIntentRequest {
  const body = exactObject(input, ["idempotencyKey", "purposeKey", "dataFormatKey", "originalFileName", "contentType", "sizeBytes", "sha256"],
    ["idempotencyKey", "purposeKey", "dataFormatKey", "originalFileName", "contentType", "sizeBytes", "sha256"]);
  const idempotencyKey = str(body.idempotencyKey, 128);
  if (!/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$/.test(idempotencyKey)) throw invalid();
  const dataFormatKey = format(body.dataFormatKey);
  const originalFileName = str(body.originalFileName, 255);
  if (originalFileName.includes("/") || originalFileName.includes("\\") || !originalFileName.toLowerCase().endsWith(`.${dataFormatKey.toLowerCase()}`)) throw invalid();
  return { idempotencyKey: idempotencyKey.toLowerCase(), purposeKey: purpose(body.purposeKey), dataFormatKey, originalFileName,
    contentType: mime(body.contentType), sizeBytes: positiveSize(body.sizeBytes), sha256: digest(body.sha256) };
}
export interface UploadFinalizeRequest {
  assetId: string; purposeKey: string; name: string; languageTag: string;
  contentType: string; sizeBytes: number; sha256: string; sourceId?: string;
}
export function parseFinalize(input: unknown): UploadFinalizeRequest {
  const body = exactObject(input, ["assetId", "purposeKey", "name", "languageTag", "contentType", "sizeBytes", "sha256", "sourceId"],
    ["assetId", "purposeKey", "name", "languageTag", "contentType", "sizeBytes", "sha256"]);
  const result: UploadFinalizeRequest = { assetId: safeId(body.assetId), purposeKey: purpose(body.purposeKey),
    name: str(body.name, 160), languageTag: language(body.languageTag), contentType: mime(body.contentType),
    sizeBytes: positiveSize(body.sizeBytes), sha256: digest(body.sha256) };
  if (body.sourceId !== undefined && body.sourceId !== null) result.sourceId = safeId(body.sourceId);
  return result;
}
export function parseEdit(input: unknown): { name: string; languageTag: string } {
  const body = exactObject(input, ["name", "languageTag"], ["name", "languageTag"]);
  return { name: str(body.name, 160), languageTag: language(body.languageTag) };
}
export function deterministicAssetId(shopId: string, key: string): string {
  const hex = createHash("sha256").update("moda-woo-knowledge-upload-v1\0").update(shopId).update("\0").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/**
 * Storage-only hostname from the canonical URL of an authenticated Shop row.
 * Never derive it from an upload request or a browser-supplied storage path.
 */
function storageHostname(canonicalSiteUrl: string): string {
  let url: URL;
  try { url = new URL(canonicalSiteUrl); }
  catch { throw unavailable(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw unavailable();
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  // IPv6 is valid for local development, but ':' and brackets are not useful
  // path characters in the R2 object browser. Tenant isolation uses shopId.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const segment = hostname.slice(1, -1).replace(/[:.]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!/^[a-f0-9-]+$/.test(segment)) throw unavailable();
    return `ipv6-${segment}`;
  }
  if (hostname.length > 253 || !hostname.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw unavailable();
  return hostname;
}

/** New keys are immutable once persisted; this helper is used for NEW intents only. */
export function wooObjectKey(environment: string, shopId: string, canonicalSiteUrl: string,
  assetId: string, formatKey: UploadFormat, createdAt: Date): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(environment) || !/^[A-Za-z0-9_-]{1,128}$/.test(shopId) ||
    !/^[a-f0-9-]{36}$/.test(assetId) || !(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime()))
    throw unavailable();
  const timestamp = createdAt.toISOString().replace(/[-:.]/g, '');
  return `merchant-knowledge/${environment}/woocommerce/${shopId}/${storageHostname(canonicalSiteUrl)}/${timestamp}-${assetId}.${formatKey.toLowerCase()}`;
}

/** Accept both the original API-017 layout and the new layout on intent replay. */
export function isWooObjectKeyForAsset(key: string, environment: string, shopId: string,
  assetId: string, formatKey: UploadFormat): boolean {
  const prefix = `merchant-knowledge/${environment}/woocommerce/${shopId}/`;
  if (typeof key !== 'string' || !key.startsWith(prefix)) return false;
  const relative = key.slice(prefix.length);
  if (relative === `${assetId}/source.${formatKey.toLowerCase()}`) return true;
  const match = /^([a-z0-9][a-z0-9.-]{0,252})\/(\d{8}T\d{9}Z)-([a-f0-9-]{36})\.(csv|xlsx)$/.exec(relative);
  return !!match && !match[1]!.includes('..') && match[3] === assetId && match[4] === formatKey.toLowerCase();
}
