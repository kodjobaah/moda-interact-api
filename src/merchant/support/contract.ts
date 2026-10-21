import { AuthoredSupportBodySchema } from "@modainteract/moda-interact-shared/merchant-communications";

export const SUPPORT_PATH = "/v1/merchant/support/messages";
export const SUPPORT_READ_PATH = /^\/v1\/merchant\/support\/messages\/([^/]+)\/read$/;
export const MAX_SUPPORT_BODY_BYTES = 32_768;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,191}$/;
const ACTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class SupportRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: "invalid_request" | "request_too_large") { super(code); }
}
export class SupportConflictError extends Error { constructor() { super("idempotency_conflict"); } }
export class SupportNotFoundError extends Error { constructor() { super("not_found"); } }
export class SupportUnavailableError extends Error { constructor() { super("support_unavailable"); } }
export class SupportIntegrityError extends Error { constructor() { super("support_integrity_invalid"); } }
export type SupportPageSize = 10 | 25 | 50;
export type SupportQuery = { page: number; pageSize: SupportPageSize };
export type SupportComposeInput = { body: string; actionId: string };
export type SupportMessage = {
  id: string; kind: "MERCHANT" | "ADMINISTRATIVE" | "SYSTEM";
  state: "PROCESSING" | "AVAILABLE" | "FAILED"; originalBody: string;
  displayBody: string | null; isTranslated: boolean; sourceLanguageTag: string;
  displayLanguageTag: string | null; systemCode: string | null; systemVersion: string | null;
  createdAt: string; readAt: string | null;
};
export type SupportPage = { schemaVersion: 1; page: number; pageSize: SupportPageSize;
  total: number; totalPages: number; unread: number; items: SupportMessage[] };
export type SupportComposeResponse = { schemaVersion: 1; messageId: string; translationId: string | null };
export type SupportReadResponse = { schemaVersion: 1; messageId: string; readAt: string };

export function parseSupportQuery(query: URLSearchParams): SupportQuery {
  const keys = [...query.keys()];
  if (keys.some(k => k !== "page" && k !== "pageSize") ||
    query.getAll("page").length > 1 || query.getAll("pageSize").length > 1) throw new SupportRequestError(400,"invalid_request");
  const p = query.get("page") ?? "1", s = query.get("pageSize") ?? "25";
  if (!/^[1-9][0-9]{0,5}$/.test(p) || !["10", "25", "50"].includes(s)) throw new SupportRequestError(400,"invalid_request");
  return { page: Number(p), pageSize: Number(s) as SupportPageSize };
}
export function parseSupportCompose(value: unknown): SupportComposeInput {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new SupportRequestError(400,"invalid_request");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record,"body") || !Object.hasOwn(record,"actionId") ||
    typeof record.actionId !== "string" || !ACTION_ID.test(record.actionId) ||
    !AuthoredSupportBodySchema.safeParse(record.body).success) throw new SupportRequestError(400,"invalid_request");
  return { body: record.body as string, actionId: record.actionId };
}
export function validSupportMessageId(value: string) { return MESSAGE_ID.test(value); }
const isDate = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const exact = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).sort().join("|") === keys.sort().join("|");
function validItem(v: unknown): v is SupportMessage {
  if (!v || Array.isArray(v) || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return exact(m,["id","kind","state","originalBody","displayBody","isTranslated","sourceLanguageTag",
    "displayLanguageTag","systemCode","systemVersion","createdAt","readAt"]) &&
    typeof m.id === "string" && validSupportMessageId(m.id) &&
    ["MERCHANT","ADMINISTRATIVE","SYSTEM"].includes(String(m.kind)) &&
    ["PROCESSING","AVAILABLE","FAILED"].includes(String(m.state)) &&
    typeof m.originalBody === "string" && (m.displayBody === null || typeof m.displayBody === "string") &&
    typeof m.isTranslated === "boolean" && typeof m.sourceLanguageTag === "string" &&
    (m.displayLanguageTag === null || typeof m.displayLanguageTag === "string") &&
    (m.systemCode === null || typeof m.systemCode === "string") &&
    (m.systemVersion === null || typeof m.systemVersion === "string") &&
    isDate(m.createdAt) && (m.readAt === null || isDate(m.readAt));
}
export function validSupportPage(v: unknown): v is SupportPage {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const x = v as Record<string, unknown>;
  return exact(x,["schemaVersion","page","pageSize","total","totalPages","unread","items"]) &&
    x.schemaVersion === 1 && Number.isSafeInteger(x.page) && Number(x.page) > 0 &&
    [10,25,50].includes(Number(x.pageSize)) && Number.isSafeInteger(x.total) && Number(x.total) >= 0 &&
    Number.isSafeInteger(x.totalPages) && Number(x.totalPages) >= 1 &&
    Number.isSafeInteger(x.unread) && Number(x.unread) >= 0 &&
    Array.isArray(x.items) && x.items.length <= Number(x.pageSize) && x.items.every(validItem);
}
export function validComposeResponse(v: unknown): v is SupportComposeResponse {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const x = v as Record<string, unknown>;
  return exact(x,["schemaVersion","messageId","translationId"]) && x.schemaVersion === 1 &&
    typeof x.messageId === "string" && validSupportMessageId(x.messageId) &&
    (x.translationId === null || typeof x.translationId === "string" && validSupportMessageId(x.translationId));
}
export function validReadResponse(v: unknown): v is SupportReadResponse {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const x = v as Record<string, unknown>;
  return exact(x,["schemaVersion","messageId","readAt"]) && x.schemaVersion === 1 &&
    typeof x.messageId === "string" && validSupportMessageId(x.messageId) && isDate(x.readAt);
}
