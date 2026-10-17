import { isIP } from "node:net";
import { MerchantKnowledgePurposeKeySchema } from "@modainteract/moda-interact-shared/merchant-knowledge";
import { ModaSupportedLanguageTagSchema } from "@modainteract/moda-interact-shared/internationalization";

export const KNOWLEDGE_SOURCES_PATH = "/v1/merchant/merchant-knowledge/sources";
export const KNOWLEDGE_ORDER_PATH = "/v1/merchant/merchant-knowledge/order";
export const MAX_KNOWLEDGE_COMMAND_BYTES = 65536;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const object = (input: unknown): input is Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input);
const keysAllowed = (row: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(row).every((key) => keys.includes(key));
/** Keep ASCII control checks explicit without control-code regex literals. */
function hasForbiddenAscii(value: string, upperBound: number): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= upperBound || code === 0x7f) return true;
  }
  return false;
}

export class KnowledgeCommandError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 503,
    readonly code: "invalid_request" | "request_too_large" | "merchant_knowledge_denied" |
      "merchant_knowledge_source_not_found" | "merchant_knowledge_conflict" |
      "merchant_knowledge_integrity_invalid" | "merchant_knowledge_unavailable") {
    super(code);
  }
}
const invalid = (): never => { throw new KnowledgeCommandError(400, "invalid_request"); };
export function parseSourceId(value: string): string {
  if (!identifier.test(value)) return invalid();
  return value;
}

/** Entry validation only; Background performs DNS/IP/redirect validation at fetch time. */
export function parseKnowledgeHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048 || hasForbiddenAscii(value, 0x20)) return invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || !host.includes(".") ||
    isIP(host) !== 0 || host.startsWith("[") || host.startsWith("-") || host.endsWith("-") ||
    !/^[a-z0-9.-]+$/.test(host) || host.split(".").some((part) => !part || part.length > 63) ||
    /\.(?:localhost|local|internal|test|invalid|example|onion|lan|home|arpa)$/.test(host) ||
    url.port !== "" || url.toString().length > 2048) return invalid();
  return url.toString();
}
function parseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160 || hasForbiddenAscii(value, 0x1f)) return invalid();
  return value.trim();
}
function parseLanguage(value: unknown): string {
  const language = ModaSupportedLanguageTagSchema.safeParse(value);
  if (!language.success) return invalid();
  return language.data;
}
function parseGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483646) return invalid();
  return value;
}
export type CreateWebSource = { name: string; purposeKey: string; dataFormatKey: "WEB_PAGE"; url: string; languageTag?: string };
export type PatchWebSource = { expectedGeneration: number; name?: string; url?: string; languageTag?: string };
export type SourceGeneration = { expectedGeneration: number };
export type SourceOrder = { sourceIds: string[] };
export function parseCreateWebSource(input: unknown): CreateWebSource {
  if (!object(input) || !keysAllowed(input, ["name", "purposeKey", "dataFormatKey", "url", "languageTag"]) ||
    input.dataFormatKey !== "WEB_PAGE" || !MerchantKnowledgePurposeKeySchema.safeParse(input.purposeKey).success) return invalid();
  return { name: parseName(input.name), purposeKey: input.purposeKey as string, dataFormatKey: "WEB_PAGE",
    url: parseKnowledgeHttpsUrl(input.url), ...(input.languageTag !== undefined ? { languageTag: parseLanguage(input.languageTag) } : {}) };
}
export function parsePatchWebSource(input: unknown): PatchWebSource {
  if (!object(input) || !keysAllowed(input, ["expectedGeneration", "name", "url", "languageTag"]) ||
    !["name", "url", "languageTag"].some((key) => Object.hasOwn(input, key))) return invalid();
  return { expectedGeneration: parseGeneration(input.expectedGeneration),
    ...(Object.hasOwn(input, "name") ? { name: parseName(input.name) } : {}),
    ...(Object.hasOwn(input, "url") ? { url: parseKnowledgeHttpsUrl(input.url) } : {}),
    ...(Object.hasOwn(input, "languageTag") ? { languageTag: parseLanguage(input.languageTag) } : {}) };
}
export function parseSourceGeneration(input: unknown): SourceGeneration {
  if (!object(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "expectedGeneration")) return invalid();
  return { expectedGeneration: parseGeneration(input.expectedGeneration) };
}
export function parseSourceOrder(input: unknown): SourceOrder {
  if (!object(input) || Object.keys(input).length !== 1 || !Array.isArray(input.sourceIds) || input.sourceIds.length > 1000 ||
    input.sourceIds.some((id: unknown) => typeof id !== "string" || !identifier.test(id)) ||
    new Set(input.sourceIds).size !== input.sourceIds.length) return invalid();
  return { sourceIds: input.sourceIds as string[] };
}
