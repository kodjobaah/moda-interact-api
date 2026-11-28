import assert from "node:assert/strict";
import test from "node:test";
import {
  humanMessagingProjection,
  recoveryConversationDetail,
} from "../../../../../src/merchant/recoveries/detail/conversation-projection.js";

import {
  attempt,
  pendingFollowUp,
  scope as baseScope,
  failed,
} from "./merchant-outreach.fixture.js";

const now = new Date("2026-10-21T12:00:00.000Z");
const scope = { ...baseScope, conversationId: "c" };
const initial = attempt(
  1,
  { sentAt: new Date("2026-10-19T00:00:00.000Z") },
  scope,
);
const conversation = {
  id: "c",
  controlMode: "HUMAN" as const,
  controlRevision: 4,
};
test("projection uses only the verified inbound query and preserves exact service window", async () => {
  let where: unknown;
  const tx = {
    conversationMessage: {
      findFirst: async (args: { where: unknown }) => {
        where = args.where;
        return { createdAt: new Date("2026-10-20T12:00:00.000Z") };
      },
    },
  } as never;
  const value = await recoveryConversationDetail(
    tx,
    conversation,
    scope,
    [initial],
    now,
  );
  assert.equal(value?.lastInboundAt, "2026-10-20T12:00:00.000Z");
  assert.equal(value?.windowExpiresAt, now.toISOString());
  assert.equal(value?.controlRevision, 4);
  assert.deepEqual(value?.followUp, {
    sequence2Used: false,
    initiatedBy: null,
  });
  assert.deepEqual(where, {
    conversationId: "c",
    direction: "INBOUND",
    senderType: "CUSTOMER",
    providerMessageId: { not: null },
    createdAt: { gte: initial.sentAt, lte: now },
  });
});
test("missing initial or conversation cannot invent inbound evidence; claimed attempt is used", async () => {
  const tx = {
    conversationMessage: {
      findFirst: async () => {
        throw Error("unexpected inbound read");
      },
    },
  } as never;
  assert.equal(
    await recoveryConversationDetail(tx, null, scope, [], now),
    null,
  );
  const result = await recoveryConversationDetail(
    tx,
    conversation,
    scope,
    [
      {
        ...pendingFollowUp(scope),
        initiatedBy: "HUMAN",
        initiationKey: "cmd",
        claimedAt: now,
      },
    ],
    now,
  );
  assert.equal(result?.lastInboundAt, null);
  assert.deepEqual(result?.followUp, {
    sequence2Used: true,
    initiatedBy: "HUMAN",
  });
});
test("merchant restriction is presentation only, defaults active and never exposes admin reason", () => {
  assert.deepEqual(humanMessagingProjection(null), {
    humanMessagingAllowed: true,
    humanMessagingStatus: "ACTIVE",
  });
  assert.deepEqual(humanMessagingProjection("SUSPENDED"), {
    humanMessagingAllowed: false,
    humanMessagingStatus: "SUSPENDED",
  });
  assert.deepEqual(humanMessagingProjection("UNEXPECTED"), {
    humanMessagingAllowed: false,
    humanMessagingStatus: "SUSPENDED",
  });
});

test("an outstanding physical follow-up retry never reopens the summary's logical slot", async () => {
  const first = attempt(
    1,
    { sentAt: new Date("2026-10-19T00:00:00.000Z") },
    scope,
  );
  const root = failed(2, 3, scope, {
    initiatedBy: "AUTOMATION",
    initiationKey: "scheduled",
    claimedAt: now,
  });
  const successor = attempt(
    3,
    {
      trigger: "NO_RESPONSE_FOLLOW_UP",
      status: "PENDING",
      sentAt: null,
      outboundMessageId: null,
      outboundMessage: null,
    },
    scope,
  );
  const inbound = new Date(now.getTime() - 60_000);
  const tx = {
    conversationMessage: { findFirst: async () => ({ createdAt: inbound }) },
  } as never;
  const result = await recoveryConversationDetail(
    tx,
    conversation,
    scope,
    [first, root, successor],
    now,
  );
  assert.deepEqual(result?.followUp, {
    sequence2Used: true,
    initiatedBy: "AUTOMATION",
  });
  assert.equal(result?.lastInboundAt, inbound.toISOString());
});
