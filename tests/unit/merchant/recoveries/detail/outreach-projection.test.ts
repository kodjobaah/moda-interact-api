import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isOutreachProjection,
  MAX_OUTREACH_HISTORY,
  projectRecoveryOutreach,
  type OutreachProjectionAttempt,
} from "../../../../../src/merchant/recoveries/detail/outreach-projection.js";

const at = new Date("2026-11-26T10:00:00.000Z");
const due = new Date("2026-11-26T11:00:00.000Z");
const input = (attempts: OutreachProjectionAttempt[]) => ({
  recoveryId: "recovery-a",
  conversationId: "conversation-a",
  generation: 1,
  lastExternalActivityAt: at,
  attempts,
});
function attempt(
  sequence = 1,
  changes: Partial<OutreachProjectionAttempt> = {},
): OutreachProjectionAttempt {
  const id =
    sequence === 1
      ? "initial"
      : sequence === 2
        ? "follow-up"
        : `retry_intent-${sequence}`;
  return {
    id,
    checkoutRecoveryId: "recovery-a",
    sequence,
    trigger: sequence === 2 ? "NO_RESPONSE_FOLLOW_UP" : "INITIAL",
    recipient: "447700900001",
    initiatedBy: "AUTOMATION",
    status: "WAITING_FOR_RESPONSE",
    sentAt: at,
    customerRespondedAt: null,
    outboundMessageId: `message-${sequence}`,
    failureCode: null,
    outboundMessage: {
      id: `message-${sequence}`,
      conversationId: "conversation-a",
      direction: "OUTBOUND",
      senderType: "AUTOMATION",
      status: "SENT",
      providerMessageId: `provider-secret-${sequence}`,
      providerDispatchKey: `dispatch-secret-${sequence}`,
      providerDispatchAdmittedAt: at,
      providerFailureCode: null,
      sentAt: at,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
    },
    deliveryRetryIntent: null,
    ...changes,
  };
}
function failed(
  sequence: number,
  nextSequence: number,
  changes: Partial<OutreachProjectionAttempt> = {},
): OutreachProjectionAttempt {
  const row = attempt(sequence, changes);
  return {
    ...row,
    status: "FAILED",
    outboundMessage: {
      ...row.outboundMessage!,
      status: "FAILED",
      failedAt: at,
    },
    deliveryRetryIntent: {
      id: `intent-${nextSequence}`,
      failedAttemptId: row.id,
      failedMessageId: row.outboundMessageId!,
      cancelledAt: null,
      policy: "AFTER_COOLDOWN",
      notBeforeAt: due,
      expectedGeneration: 1,
      expectedLastExternalActivityAt: at,
    },
  };
}

test("projects empty slots and preserves separate logical initial/follow-up slots", () => {
  const empty = projectRecoveryOutreach(input([]))!;
  assert.deepEqual(empty.initial, {
    state: "MISSING",
    currentSequence: null,
    history: [],
  });
  assert.deepEqual(empty.followUp, empty.initial);
  const value = projectRecoveryOutreach(input([attempt(2), attempt(1)]))!;
  assert.equal(value.initial.currentSequence, 1);
  assert.equal(value.followUp.currentSequence, 2);
  assert.equal(value.initial.history[0]?.deliveryState, "PROVIDER_ACCEPTED");
  assert.equal(isOutreachProjection(value), true);
});

test("follows independent deterministic retry chains, not the globally highest sequence", () => {
  const first = failed(1, 4);
  const follow = failed(2, 3);
  const f3 = attempt(3, { trigger: "NO_RESPONSE_FOLLOW_UP" });
  const i4 = failed(4, 5);
  const i5 = attempt(5);
  const value = projectRecoveryOutreach(input([i5, f3, i4, follow, first]))!;
  assert.equal(value.initial.currentSequence, 5);
  assert.equal(value.followUp.currentSequence, 3);
  assert.deepEqual(
    value.initial.history.map((item) => item.sequence),
    [1, 4, 5],
  );
  assert.deepEqual(
    value.followUp.history.map((item) => item.sequence),
    [2, 3],
  );
  assert.equal(value.initial.history[0]?.retryDecision, "SUCCESSOR_CREATED");
  assert.equal(value.initial.history[1]?.retryDecision, "SUCCESSOR_CREATED");
  assert.equal(value.followUp.history[0]?.retryDecision, "SUCCESSOR_CREATED");
  assert.equal(isOutreachProjection(value), true);
  assert.doesNotMatch(
    JSON.stringify(value),
    /447700900001|provider-secret|dispatch-secret|conversation-a|intent-4/,
  );
});

test("a recorded decision alone does not create an attempt; stale or cancelled decisions hide the due time", () => {
  const original = failed(1, 3);
  const project = (row: OutreachProjectionAttempt) =>
    projectRecoveryOutreach(input([row]))!.initial;
  assert.equal(project(original).currentSequence, 1);
  assert.equal(project(original).history[0]?.retryDecision, "AFTER_COOLDOWN");
  assert.equal(
    project(original).history[0]?.retryNotBeforeAt,
    due.toISOString(),
  );
  const stale = {
    ...original,
    deliveryRetryIntent: {
      ...original.deliveryRetryIntent!,
      expectedGeneration: 2,
    },
  };
  assert.equal(project(stale).history[0]?.retryDecision, "STALE");
  assert.equal(project(stale).history[0]?.retryNotBeforeAt, null);
  const cancelled = {
    ...original,
    deliveryRetryIntent: { ...original.deliveryRetryIntent!, cancelledAt: at },
  };
  assert.equal(project(cancelled).history[0]?.retryDecision, "CANCELLED");
  const hold = {
    ...original,
    deliveryRetryIntent: {
      ...original.deliveryRetryIntent!,
      policy: "PROVIDER_POLICY_HOLD",
    },
  };
  assert.equal(project(hold).history[0]?.retryDecision, "PROVIDER_POLICY_HOLD");
});

test("an admitted request with an unknown outcome remains unconfirmed, including a FAILED status without rejection evidence", () => {
  const row = attempt();
  const pending = {
    ...row.outboundMessage!,
    status: "PENDING",
    sentAt: null,
    providerMessageId: null,
  };
  const project = (
    message: NonNullable<OutreachProjectionAttempt["outboundMessage"]>,
    failureCode: string | null = null,
  ) =>
    projectRecoveryOutreach(
      input([{ ...row, sentAt: null, outboundMessage: message, failureCode }]),
    )!.initial.history[0];
  assert.equal(project(pending)?.deliveryState, "UNCONFIRMED");
  const failedUnknown = { ...pending, status: "FAILED", failedAt: at };
  assert.equal(project(failedUnknown)?.deliveryState, "UNCONFIRMED");
  assert.equal(
    project(failedUnknown, "PROVIDER_REJECTED")?.deliveryState,
    "FAILED",
  );
  assert.equal(
    project({
      ...pending,
      providerDispatchKey: null,
      providerDispatchAdmittedAt: null,
    })?.deliveryState,
    "NO_RECORDED_SUBMISSION",
  );
});

test("late positive receipt remains visible and conflicting successor cannot become current", () => {
  const original = failed(1, 3);
  original.outboundMessage = {
    ...original.outboundMessage!,
    status: "READ",
    readAt: due,
  };
  const value = projectRecoveryOutreach(input([original, attempt(3)]))!;
  assert.equal(value.initial.state, "CONFLICT");
  assert.equal(value.initial.currentSequence, null);
  assert.equal(value.initial.history[0]?.deliveryState, "READ");
  assert.equal(value.initial.history[0]?.retryDecision, "UNKNOWN");
  assert.equal(isOutreachProjection(value), true);
});

test("orphan, mismatched recipient, wrong trigger and invalid intent cannot select a successor", () => {
  const original = failed(1, 3);
  for (const rows of [
    [attempt(3)],
    [original, attempt(4)],
    [original, attempt(3, { recipient: "447700900002" })],
    [original, attempt(3, { trigger: "POST_WINDOW_FOLLOW_UP" })],
    [
      {
        ...original,
        deliveryRetryIntent: {
          ...original.deliveryRetryIntent!,
          failedMessageId: "different",
        },
      },
      attempt(3),
    ],
  ]) {
    const value = projectRecoveryOutreach(input(rows))!;
    assert.equal(value.initial.state, "CONFLICT");
    assert.equal(value.initial.currentSequence, null);
  }
});

test("foreign recovery/message, duplicate physical identity, and overflow fail closed", () => {
  const row = attempt();
  assert.equal(
    projectRecoveryOutreach(input([{ ...row, checkoutRecoveryId: "foreign" }])),
    null,
  );
  assert.equal(
    projectRecoveryOutreach(
      input([
        {
          ...row,
          outboundMessage: {
            ...row.outboundMessage!,
            conversationId: "foreign",
          },
        },
      ]),
    ),
    null,
  );
  assert.equal(projectRecoveryOutreach(input([row, row])), null);
  assert.equal(
    projectRecoveryOutreach(
      input(
        Array.from({ length: MAX_OUTREACH_HISTORY + 1 }, (_, index) =>
          attempt(index + 1),
        ),
      ),
    ),
    null,
  );
});

test("response validation rejects leaked fields, invalid state, duplicate sequence and invalid date", () => {
  const valid = projectRecoveryOutreach(input([attempt()]))!;
  assert.equal(isOutreachProjection(valid), true);
  assert.equal(isOutreachProjection({ ...valid, recipient: "secret" }), false);
  assert.equal(
    isOutreachProjection({
      ...valid,
      initial: { ...valid.initial, currentSequence: 9 },
    }),
    false,
  );
  const row = valid.initial.history[0]!;
  for (const change of [
    { providerMessageId: "secret" },
    { sentAt: "2026-02-31T00:00:00.000Z" },
    { retry: true },
    { retryDecision: "AFTER_COOLDOWN", retryNotBeforeAt: null },
  ]) {
    assert.equal(
      isOutreachProjection({
        ...valid,
        initial: { ...valid.initial, history: [{ ...row, ...change }] },
      }),
      false,
    );
  }
  assert.equal(
    isOutreachProjection({
      ...valid,
      followUp: { state: "CONFLICT", currentSequence: null, history: [row] },
    }),
    false,
  );
});
