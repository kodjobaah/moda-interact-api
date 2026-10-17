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
export function wooObjectKey(environment: string, shopId: string, assetId: string, formatKey: UploadFormat): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(environment) || !/^[A-Za-z0-9_-]{1,128}$/.test(shopId) ||
    !/^[a-f0-9-]{36}$/.test(assetId)) throw unavailable();
  return `merchant-knowledge/${environment}/woocommerce/${shopId}/${assetId}/source.${formatKey.toLowerCase()}`;
}
