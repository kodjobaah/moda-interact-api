import {
  outreachSlot,
  selectEffectiveOutreachAttempt,
  type OutreachAttemptIdentity,
  type OutreachMessageIdentity,
  type OutreachSlot,
} from "./outreach-lineage.js";

export const MAX_OUTREACH_HISTORY = 100;
const ATTEMPT_STATUSES = [
  "PENDING",
  "WAITING_FOR_RESPONSE",
  "ENGAGED",
  "NO_RESPONSE",
  "CAPACITY_BLOCKED",
  "CANCELLED",
  "FAILED",
] as const;
const ACTORS = ["HUMAN", "AGENT", "AUTOMATION"] as const;
const DELIVERY_STATES = [
  "NO_RECORDED_SUBMISSION",
  "UNCONFIRMED",
  "PROVIDER_ACCEPTED",
  "DELIVERED",
  "READ",
  "FAILED",
] as const;
const RETRY_POLICIES = [
  "AFTER_COOLDOWN",
  "PROVIDER_POLICY_HOLD",
  "REPAIR_REQUIRED",
  "REVIEW_REQUIRED",
  "DO_NOT_RETRY",
] as const;
const RETRY_DECISIONS = [
  "NONE",
  "SUCCESSOR_CREATED",
  "CANCELLED",
  "STALE",
  "UNKNOWN",
  ...RETRY_POLICIES,
] as const;
const SLOT_STATES = ["MISSING", "CURRENT", "CONFLICT"] as const;

type DeliveryState = (typeof DELIVERY_STATES)[number];
type RetryDecision = (typeof RETRY_DECISIONS)[number];
type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
type Actor = (typeof ACTORS)[number];
type SlotState = (typeof SLOT_STATES)[number];

export type OutreachProjectionAttempt = Omit<
  OutreachAttemptIdentity,
  "outboundMessage" | "deliveryRetryIntent"
> & {
  failureCode: string | null;
  outboundMessage:
    | (OutreachMessageIdentity & {
        providerDispatchKey: string | null;
        providerDispatchAdmittedAt: Date | null;
        providerFailureCode: string | null;
      })
    | null;
  deliveryRetryIntent:
    | (NonNullable<OutreachAttemptIdentity["deliveryRetryIntent"]> & {
        policy: string;
        notBeforeAt: Date | null;
        expectedGeneration: number;
        expectedLastExternalActivityAt: Date;
      })
    | null;
};

export interface OutreachHistoryItem {
  sequence: number;
  retry: boolean;
  initiatedBy: Actor | null;
  attemptStatus: AttemptStatus;
  deliveryState: DeliveryState;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  retryDecision: RetryDecision;
  retryNotBeforeAt: string | null;
}
export interface OutreachSlotProjection {
  state: SlotState;
  currentSequence: number | null;
  history: OutreachHistoryItem[];
}
export interface RecoveryOutreachProjection {
  schemaVersion: 1;
  recoveryId: string;
  initial: OutreachSlotProjection;
  followUp: OutreachSlotProjection;
}

function member<const T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}
function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/** A recorded permit is not delivery evidence. Never interpret an unknown
 * provider outcome as a failure merely because the attempt is closed. */
function deliveryState(attempt: OutreachProjectionAttempt): DeliveryState {
  const message = attempt.outboundMessage;
  if (!message)
    return attempt.sentAt ? "UNCONFIRMED" : "NO_RECORDED_SUBMISSION";
  if (message.providerMessageId && message.sentAt) {
    if (message.status === "READ" && message.readAt) return "READ";
    if (message.status === "DELIVERED" && message.deliveredAt)
      return "DELIVERED";
    if (
      message.status === "SENT" &&
      !message.failedAt &&
      !message.providerFailureCode &&
      !message.deliveredAt &&
      !message.readAt
    )
      return "PROVIDER_ACCEPTED";
  }
  if (
    message.status === "FAILED" &&
    message.failedAt &&
    !message.deliveredAt &&
    !message.readAt &&
    (message.providerMessageId ||
      (!message.sentAt &&
        (attempt.failureCode === "PROVIDER_REJECTED" ||
          (attempt.failureCode === "WHATSAPP_RECIPIENT_UNDELIVERABLE" &&
            message.providerFailureCode === "131026"))))
  ) {
    return "FAILED";
  }
  if (
    message.providerDispatchKey ||
    message.providerDispatchAdmittedAt ||
    message.providerMessageId ||
    message.sentAt ||
    message.deliveredAt ||
    message.readAt ||
    message.failedAt ||
    message.providerFailureCode ||
    attempt.sentAt ||
    (message.status !== "PENDING" && message.status !== "FAILED")
  )
    return "UNCONFIRMED";
  return "NO_RECORDED_SUBMISSION";
}

interface ProjectionInput {
  recoveryId: string;
  conversationId: string | null;
  generation: number;
  lastExternalActivityAt: Date;
  attempts: readonly OutreachProjectionAttempt[];
}

function decision(
  input: ProjectionInput,
  attempt: OutreachProjectionAttempt,
  delivery: DeliveryState,
  hasSuccessor: boolean,
  conflict: boolean,
): RetryDecision {
  const intent = attempt.deliveryRetryIntent;
  if (!intent) return "NONE";
  if (conflict) return "UNKNOWN";
  if (hasSuccessor) return "SUCCESSOR_CREATED";
  if (intent.cancelledAt) return "CANCELLED";
  if (
    intent.expectedGeneration !== input.generation ||
    intent.expectedLastExternalActivityAt.getTime() !==
      input.lastExternalActivityAt.getTime()
  )
    return "STALE";
  if (
    delivery !== "FAILED" ||
    attempt.status !== "FAILED" ||
    attempt.customerRespondedAt ||
    attempt.initiatedBy === "HUMAN" ||
    attempt.outboundMessage?.senderType !== "AUTOMATION" ||
    !member(RETRY_POLICIES, intent.policy)
  )
    return "UNKNOWN";
  const requiresDue =
    intent.policy === "AFTER_COOLDOWN" ||
    intent.policy === "PROVIDER_POLICY_HOLD";
  return requiresDue === (intent.notBeforeAt !== null)
    ? intent.policy
    : "UNKNOWN";
}

/** Two logical slots, physical history only. Null means invalid ownership or
 * unbounded input; callers fail closed rather than return an incomplete chain.
 * Neither the recorded decision nor its not-before time authorises a send. */
export function projectRecoveryOutreach(
  input: ProjectionInput,
): RecoveryOutreachProjection | null {
  if (input.attempts.length > MAX_OUTREACH_HISTORY) return null;
  const sequences = new Set<number>();
  const ids = new Set<string>();
  const messages = new Set<string>();
  for (const attempt of input.attempts) {
    const message = attempt.outboundMessage;
    if (
      attempt.checkoutRecoveryId !== input.recoveryId ||
      !attempt.id ||
      ids.has(attempt.id) ||
      !Number.isSafeInteger(attempt.sequence) ||
      attempt.sequence < 1 ||
      attempt.sequence > 2_147_483_647 ||
      sequences.has(attempt.sequence) ||
      !outreachSlot(attempt.trigger) ||
      !member(ATTEMPT_STATUSES, attempt.status) ||
      (attempt.initiatedBy !== null && !member(ACTORS, attempt.initiatedBy)) ||
      (attempt.outboundMessageId === null) !== (message === null) ||
      (message &&
        (!input.conversationId ||
          message.conversationId !== input.conversationId ||
          message.id !== attempt.outboundMessageId ||
          message.direction !== "OUTBOUND" ||
          messages.has(message.id)))
    )
      return null;
    ids.add(attempt.id);
    sequences.add(attempt.sequence);
    if (message) messages.add(message.id);
  }
  const projectSlot = (slot: OutreachSlot): OutreachSlotProjection => {
    const selection = selectEffectiveOutreachAttempt({ ...input, slot });
    const history = input.attempts
      .filter((attempt) => outreachSlot(attempt.trigger) === slot)
      .sort((a, b) => a.sequence - b.sequence)
      .map((attempt): OutreachHistoryItem => {
        const delivery = deliveryState(attempt);
        const hasSuccessor =
          selection.kind === "selected" &&
          selection.chain.some(
            (entry, index) =>
              entry.id === attempt.id && index < selection.chain.length - 1,
          );
        const retryDecision = decision(
          input,
          attempt,
          delivery,
          hasSuccessor,
          selection.kind === "conflict",
        );
        const message = attempt.outboundMessage;
        return {
          sequence: attempt.sequence,
          retry: attempt.sequence >= 3,
          initiatedBy: attempt.initiatedBy as Actor | null,
          attemptStatus: attempt.status as AttemptStatus,
          deliveryState: delivery,
          sentAt: iso(message?.sentAt ?? null),
          deliveredAt: iso(message?.deliveredAt ?? null),
          readAt: iso(message?.readAt ?? null),
          failedAt: iso(message?.failedAt ?? null),
          retryDecision,
          retryNotBeforeAt:
            retryDecision === "AFTER_COOLDOWN" ||
            retryDecision === "PROVIDER_POLICY_HOLD"
              ? iso(attempt.deliveryRetryIntent?.notBeforeAt ?? null)
              : null,
        };
      });
    return {
      state:
        selection.kind === "selected"
          ? "CURRENT"
          : selection.kind === "missing"
            ? "MISSING"
            : "CONFLICT",
      currentSequence:
        selection.kind === "selected" ? selection.current.sequence : null,
      history,
    };
  };
  return {
    schemaVersion: 1,
    recoveryId: input.recoveryId,
    initial: projectSlot("INITIAL"),
    followUp: projectSlot("FOLLOW_UP"),
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const dateOrNull = (value: unknown): boolean =>
  value === null ||
  (typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value);

function isHistoryItem(value: unknown): value is OutreachHistoryItem {
  if (
    !object(value) ||
    !exact(value, [
      "sequence",
      "retry",
      "initiatedBy",
      "attemptStatus",
      "deliveryState",
      "sentAt",
      "deliveredAt",
      "readAt",
      "failedAt",
      "retryDecision",
      "retryNotBeforeAt",
    ])
  )
    return false;
  return (
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 1 &&
    value.sequence <= 2_147_483_647 &&
    value.retry === value.sequence >= 3 &&
    (value.initiatedBy === null || member(ACTORS, value.initiatedBy)) &&
    member(ATTEMPT_STATUSES, value.attemptStatus) &&
    member(DELIVERY_STATES, value.deliveryState) &&
    member(RETRY_DECISIONS, value.retryDecision) &&
    [
      value.sentAt,
      value.deliveredAt,
      value.readAt,
      value.failedAt,
      value.retryNotBeforeAt,
    ].every(dateOrNull) &&
    (value.retryDecision === "AFTER_COOLDOWN" ||
      value.retryDecision === "PROVIDER_POLICY_HOLD") ===
      (value.retryNotBeforeAt !== null)
  );
}
function isSlot(
  value: unknown,
  originalSequence: number,
): value is OutreachSlotProjection {
  if (
    !object(value) ||
    !exact(value, ["state", "currentSequence", "history"]) ||
    !member(SLOT_STATES, value.state) ||
    !Array.isArray(value.history) ||
    value.history.length > MAX_OUTREACH_HISTORY ||
    !value.history.every(isHistoryItem)
  )
    return false;
  const history: OutreachHistoryItem[] = value.history;
  if (
    history.some(
      (item, index) =>
        index > 0 && item.sequence <= history[index - 1]!.sequence,
    )
  )
    return false;
  if (value.state === "MISSING")
    return value.currentSequence === null && history.length === 0;
  if (value.state === "CONFLICT") return value.currentSequence === null;
  return (
    history[0]?.sequence === originalSequence &&
    history.at(-1)?.sequence === value.currentSequence
  );
}
export function isOutreachProjection(
  value: unknown,
): value is RecoveryOutreachProjection {
  if (
    !object(value) ||
    !exact(value, ["schemaVersion", "recoveryId", "initial", "followUp"]) ||
    value.schemaVersion !== 1 ||
    typeof value.recoveryId !== "string" ||
    !/^[A-Za-z0-9_-]{1,191}$/.test(value.recoveryId) ||
    !isSlot(value.initial, 1) ||
    !isSlot(value.followUp, 2)
  )
    return false;
  const history = [...value.initial.history, ...value.followUp.history];
  return (
    history.length <= MAX_OUTREACH_HISTORY &&
    new Set(history.map((item) => item.sequence)).size === history.length
  );
}
