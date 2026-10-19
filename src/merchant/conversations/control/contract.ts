/** Woo-only HTTP contract; Prisma remains the canonical durable contract. */
export const CONVERSATION_CONTROL_PATH = /^\/v1\/merchant\/conversations\/(.+)\/control$/;
export const MAX_CONTROL_BODY_BYTES = 512;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,191}$/;

export type ConversationControlTarget = "AI" | "HUMAN";
export type ConversationControlRequest = Readonly<{
  targetMode: ConversationControlTarget;
  expectedControlRevision: number;
}>;
export type ConversationControlResponse = Readonly<{
  schemaVersion: 1;
  conversationId: string;
  controlMode: ConversationControlTarget;
  controlRevision: number;
  controlChangedAt: string | null;
}>;

export function validConversationId(value: string): boolean {
  return IDENTIFIER.test(value);
}

export class ConversationControlRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: "invalid_request" | "request_too_large") {
    super(code);
  }
}
export class ConversationControlNotFoundError extends Error {
  constructor() { super("not_found"); }
}
export class ConversationControlSuspendedError extends Error {
  constructor() { super("human_messaging_suspended"); }
}
export class ConversationControlIntegrityError extends Error {
  constructor() { super("conversation_control_integrity_invalid"); }
}
export class ConversationControlConflictError extends Error {
  constructor(
    readonly code: "stale_control_revision" | "conversation_control_conflict",
    readonly current?: Readonly<{ controlMode: ConversationControlTarget; controlRevision: number }>,
  ) { super(code); }
}

export function parseControlRequest(value: unknown): ConversationControlRequest {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new ConversationControlRequestError(400, "invalid_request");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== 2 || !keys.includes("targetMode") || !keys.includes("expectedControlRevision") ||
    (object.targetMode !== "HUMAN" && object.targetMode !== "AI") ||
    !Number.isSafeInteger(object.expectedControlRevision) ||
    (object.expectedControlRevision as number) < 0 || (object.expectedControlRevision as number) > 2_147_483_647) {
    throw new ConversationControlRequestError(400, "invalid_request");
  }
  return { targetMode: object.targetMode, expectedControlRevision: object.expectedControlRevision as number };
}

export function validControlResponse(value: unknown): value is ConversationControlResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).sort().join(",") === "controlChangedAt,controlMode,controlRevision,conversationId,schemaVersion" &&
    data.schemaVersion === 1 && typeof data.conversationId === "string" && validConversationId(data.conversationId) &&
    (data.controlMode === "AI" || data.controlMode === "HUMAN") &&
    Number.isSafeInteger(data.controlRevision) && (data.controlRevision as number) >= 0 &&
    (data.controlChangedAt === null || (typeof data.controlChangedAt === "string" &&
      !Number.isNaN(Date.parse(data.controlChangedAt))));
}
