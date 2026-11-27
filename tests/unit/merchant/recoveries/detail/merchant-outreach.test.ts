import assert from "node:assert/strict";
import test from "node:test";
import { resolveMerchantOutreach } from "../../../../../src/merchant/recoveries/detail/merchant-outreach.js";
import {
  configuredFollowUpDue,
  windowOpen,
} from "../../../../../src/merchant/conversations/messages/eligibility.js";
import {
  scope,
  at,
  now,
  attempt,
  failed,
  delivered,
  pendingFollowUp,
} from "./merchant-outreach.fixture.js";

test("legacy accepted initial and pristine sequence two retain their distinct logical slots", () => {
  const initial = attempt();
  const value = resolveMerchantOutreach(
    scope,
    [initial, pendingFollowUp()],
    now,
  );
  assert.equal(value.initial, initial);
  assert.equal(value.replyAnchor, initial);
  assert.equal(value.followUpUsed, false);
  assert.equal(value.initiatedBy, null);
});

for (const platform of ["SHOPIFY", "WOOCOMMERCE"] as const) {
  test(`${platform}: only the delivered, correctly admitted chain head supplies a new follow-up promise`, () => {
    const owner = { ...scope, platform };
    const original = failed(1, 3, owner);
    const due = new Date(now.getTime() + 60_000);
    const head = delivered(3, owner, { followUpDueAt: due });
    const accepted = {
      ...head,
      outboundMessage: {
        ...head.outboundMessage!,
        status: "SENT",
        deliveredAt: null,
      },
    };
    assert.equal(
      resolveMerchantOutreach(owner, [original, accepted], now).initial,
      null,
    );
    const value = resolveMerchantOutreach(owner, [head, original], now);
    assert.equal(value.initial, head);
    assert.equal(value.replyAnchor, original);
    assert.equal(
      configuredFollowUpDue(value.initial!.followUpDueAt, now),
      false,
    );
    assert.equal(
      configuredFollowUpDue(value.initial!.followUpDueAt, due),
      true,
    );
    for (const change of [
      { providerDispatchKey: "wrong-permit" },
      { providerDispatchAdmittedAt: null },
      { providerDispatchControlRevision: null },
      { dispatchProviderPhoneNumberId: "999999" },
      { dispatchProviderAccountId: null },
      { sentAt: new Date(at.getTime() + 1) },
      { failedAt: at },
      { conversationId: "foreign" },
      { providerMessageId: null },
    ]) {
      assert.equal(
        resolveMerchantOutreach(
          owner,
          [
            original,
            {
              ...head,
              outboundMessage: { ...head.outboundMessage!, ...change },
            },
          ],
          now,
        ).initial,
        null,
      );
    }
  });
}

test("failed original, pending retry, cancelled intent and late predecessor receipt never grant a new proactive send", () => {
  const original = failed(1, 3);
  const pending = attempt(3, {
    sentAt: null,
    status: "PENDING",
    outboundMessageId: null,
    outboundMessage: null,
  });
  const cancelled = {
    ...original,
    deliveryRetryIntent: { ...original.deliveryRetryIntent!, cancelledAt: at },
  };
  const late = {
    ...original,
    outboundMessage: {
      ...original.outboundMessage!,
      status: "READ",
      readAt: now,
    },
  };
  for (const rows of [
    [original],
    [original, pending],
    [cancelled, delivered(3)],
    [late, delivered(3)],
    [delivered(3)],
  ]) {
    assert.equal(resolveMerchantOutreach(scope, rows, now).initial, null);
  }
  const contact = resolveMerchantOutreach(
    scope,
    [original, pending],
    now,
  ).replyAnchor;
  assert.equal(contact, original); // A verified inbound still opens its own service window.
  assert.equal(windowOpen(new Date(now.getTime() - 60_000), now), true);
});

test("the original sequence two remains consumed during every follow-up retry state", () => {
  const initial = attempt();
  const root = failed(2, 3, scope, {
    initiatedBy: "AUTOMATION",
    initiationKey: "scheduled",
    claimedAt: at,
  });
  const successor = attempt(3, {
    trigger: "NO_RESPONSE_FOLLOW_UP",
    status: "PENDING",
    initiatedBy: "AUTOMATION",
    initiationKey: "retry",
    claimedAt: at,
    sentAt: null,
    outboundMessageId: null,
    outboundMessage: null,
  });
  for (const rows of [
    [initial, root],
    [initial, root, successor],
    [
      initial,
      root,
      delivered(3, scope, {
        trigger: "NO_RESPONSE_FOLLOW_UP",
        initiatedBy: "AUTOMATION",
        initiationKey: "retry",
        claimedAt: at,
      }),
    ],
  ]) {
    const value = resolveMerchantOutreach(scope, rows, now);
    assert.equal(value.followUpUsed, true);
    assert.equal(value.initiatedBy, "AUTOMATION");
  }
  assert.equal(
    resolveMerchantOutreach(scope, [initial, successor], now).followUpUsed,
    true,
  );
  assert.equal(
    resolveMerchantOutreach(
      scope,
      [initial, { ...pendingFollowUp(), sentAt: at }],
      now,
    ).followUpUsed,
    true,
  );
});

test("foreign or oversized histories fail closed and never reopen the logical follow-up slot", () => {
  for (const rows of [
    [attempt(1, { checkoutRecoveryId: "foreign" })],
    Array(101).fill(attempt()),
  ]) {
    assert.deepEqual(resolveMerchantOutreach(scope, rows, now), {
      replyAnchor: null,
      initial: null,
      followUpUsed: true,
      initiatedBy: null,
    });
  }
  const mismatch = attempt();
  mismatch.outboundMessage = {
    ...mismatch.outboundMessage!,
    conversationId: "foreign",
  };
  const value = resolveMerchantOutreach(scope, [mismatch], now);
  assert.equal(value.initial, null);
  assert.equal(value.replyAnchor, null);
});

test("an outstanding retry decision or contradictory failed attempt cannot authorize proactive outreach", () => {
  const original = failed(1, 3);
  const accepted = {
    ...original,
    outboundMessage: {
      ...original.outboundMessage!,
      status: "SENT",
      failedAt: null,
    },
  };
  assert.equal(resolveMerchantOutreach(scope, [accepted], now).initial, null);
  assert.equal(
    resolveMerchantOutreach(scope, [{ ...accepted, status: "SENT" }], now)
      .initial,
    null,
  );
  assert.equal(
    resolveMerchantOutreach(
      scope,
      [{ ...accepted, deliveryRetryIntent: null }],
      now,
    ).initial,
    null,
  );
});
