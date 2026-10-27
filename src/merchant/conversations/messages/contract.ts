import { createHash } from "node:crypto";

/** API-local v1 wire schema; command/credit persistence remains owned by DATABASE-001. */
export const POST_MESSAGE_PATH = /^\/v1\/merchant\/conversations\/([^/]+)\/messages$/;
export const FOLLOW_UP_TEMPLATES_PATH = /^\/v1\/merchant\/conversations\/([^/]+)\/follow-up-templates$/;
export const SEND_STATUS_PATH = /^\/v1\/merchant\/conversations\/([^/]+)\/send-commands\/([^/]+)$/;
export const MAX_SEND_BODY_BYTES = 6_144;
const idPattern = /^[A-Za-z0-9_-]{1,191}$/;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const templatePattern = /^[a-z][a-z0-9_]{0,254}$/;
const languagePattern = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
/** Equivalent to the forbidden C0/DEL ranges, without a no-control-regex violation.
 * TAB, LF and CR retain the same treatment as the original wire contract.
 */
function hasForbiddenControls(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d))
      return true;
  }
  return false;
}

export type HumanSendKind = "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE";
export type HumanSendInput = Readonly<{
  kind: "HUMAN_TEXT"; expectedControlRevision: number; idempotencyKey: string; textBody: string;
} | {
  kind: "RECOVERY_FOLLOW_UP_TEMPLATE"; expectedControlRevision: number; idempotencyKey: string;
  templateName: string; templateLanguage: string; templateParameters: readonly string[] | Readonly<Record<string, never>>;
}>;
export type ModerationStatus = "moderation_pending" | "moderation_allowed" | "moderation_blocked" |
  "moderation_review_required" | "moderation_retryable_error";
export type SendState = "ACCEPTED" | "CLAIMED" | "DISPATCH_ADMITTED" | "SENT" | "FAILED" | "CANCELLED" | "UNKNOWN";
export type SendResponse = Readonly<{ schemaVersion: 1; commandId: string; conversationId: string;
  kind: HumanSendKind; state: SendState; controlRevision: number }>;
export type SendStatusResponse = Readonly<{ schemaVersion: 1; commandId: string; conversationId: string;
  kind: HumanSendKind; state: SendState; createdAt: string; updatedAt: string;
  messageId: string | null; failureCode: string | null; moderationStatus: ModerationStatus;
  moderationReasonCode: string | null }>;
export type SendErrorCode = "invalid_request" | "request_too_large" | "not_found" |
  "human_messaging_suspended" | "idempotency_conflict" | "stale_control_revision" |
  "not_human_controlled" | "follow_up_unavailable" | "template_not_allowed" |
  "service_window_closed" | "recipient_unavailable" | "send_entitlement_unavailable" |
  "human_content_invalid" | "internal_error";
export class SendHttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500,
    readonly code: SendErrorCode) { super(code); }
}
export function validIdentifier(input: string): boolean { return idPattern.test(input); }
const validRevision = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 2147483647;
const fail = (): never => { throw new SendHttpError(400, "invalid_request"); };

/** No client-supplied provider variables. BG007 binds trusted checkout and
 * offer values after its final entitlement, consent and provider-state checks.
 * {} is retained as the empty legacy-wire synonym; nonempty shapes fail.
 */
function parameters(input: unknown): readonly string[] | Readonly<Record<string, never>> {
  if (Array.isArray(input) && input.length === 0) return [];
  if (input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0) return {};
  return fail();
}
export function parseHumanSendInput(raw: unknown): HumanSendInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const object = raw as Record<string, unknown>;
  if (!validRevision(object.expectedControlRevision) || typeof object.idempotencyKey !== "string" ||
    !keyPattern.test(object.idempotencyKey)) return fail();
  if (object.kind === "HUMAN_TEXT") {
    if (Object.keys(object).sort().join(",") !== "expectedControlRevision,idempotencyKey,kind,textBody" ||
      typeof object.textBody !== "string" || object.textBody !== object.textBody.trim() ||
      !object.textBody || [...object.textBody].length > 4_000 || hasForbiddenControls(object.textBody)) return fail();
    return { kind: "HUMAN_TEXT", expectedControlRevision: object.expectedControlRevision,
      idempotencyKey: object.idempotencyKey, textBody: object.textBody };
  }
  if (object.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
    if (Object.keys(object).sort().join(",") !== "expectedControlRevision,idempotencyKey,kind,templateLanguage,templateName,templateParameters" ||
      typeof object.templateName !== "string" || !templatePattern.test(object.templateName) ||
      typeof object.templateLanguage !== "string" || !languagePattern.test(object.templateLanguage)) return fail();
    return { kind: "RECOVERY_FOLLOW_UP_TEMPLATE", expectedControlRevision: object.expectedControlRevision,
      idempotencyKey: object.idempotencyKey, templateName: object.templateName,
      templateLanguage: object.templateLanguage, templateParameters: parameters(object.templateParameters) };
  }
  return fail();
}

/** Canonical v1 payload excludes retry key; same key and different revision/content conflicts. */
export function canonicalHumanPayload(conversationId: string, input: HumanSendInput): string {
  const base = { contract: "moda.woo.human-send.v1", conversationId,
    controlRevision: input.expectedControlRevision, kind: input.kind };
  return input.kind === "HUMAN_TEXT"
    ? JSON.stringify({ ...base, textBody: input.textBody })
    : JSON.stringify({ ...base, templateName: input.templateName, templateLanguage: input.templateLanguage,
      templateParameters: input.templateParameters });
}
export function humanPayloadDigest(conversationId: string, input: HumanSendInput): string {
  return createHash("sha256").update(canonicalHumanPayload(conversationId, input), "utf8").digest("hex");
}

const states = new Set<SendState>(["ACCEPTED", "CLAIMED", "DISPATCH_ADMITTED", "SENT", "FAILED", "CANCELLED", "UNKNOWN"]);
export function isSendResponse(value: unknown): value is SendResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(",") === "commandId,controlRevision,conversationId,kind,schemaVersion,state" &&
    v.schemaVersion === 1 && typeof v.commandId === "string" && validIdentifier(v.commandId) &&
    typeof v.conversationId === "string" && validIdentifier(v.conversationId) &&
    (v.kind === "HUMAN_TEXT" || v.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") &&
    states.has(v.state as SendState) && validRevision(v.controlRevision);
}
export function isSendStatusResponse(value: unknown): value is SendStatusResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(",") === "commandId,conversationId,createdAt,failureCode,kind,messageId,moderationReasonCode,moderationStatus,schemaVersion,state,updatedAt" &&
    v.schemaVersion === 1 && typeof v.commandId === "string" && validIdentifier(v.commandId) &&
    typeof v.conversationId === "string" && validIdentifier(v.conversationId) &&
    (v.kind === "HUMAN_TEXT" || v.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") &&
    states.has(v.state as SendState) &&
    typeof v.createdAt === "string" && !Number.isNaN(Date.parse(v.createdAt)) &&
    typeof v.updatedAt === "string" && !Number.isNaN(Date.parse(v.updatedAt)) &&
    (v.messageId === null || (typeof v.messageId === "string" && validIdentifier(v.messageId))) &&
    (v.failureCode === null || typeof v.failureCode === "string") &&
    (v.moderationReasonCode === null || (typeof v.moderationReasonCode === "string" &&
      ["moderation_blocked", "moderation_review_required", "moderation_empty_input", "moderation_unavailable"].includes(v.moderationReasonCode))) &&
    ["moderation_pending", "moderation_allowed", "moderation_blocked", "moderation_review_required", "moderation_retryable_error"].includes(v.moderationStatus as string);
}
