import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { readUsageRecoverySources, type UsageSourceEvent } from "../../../../src/merchant/usage-history/sources.js";

const shopId = "shop_a";
const debit = (id: string, sourceId: string | null = null): UsageSourceEvent => ({
  id, metric: "RECOVERY_CONVERSATION", correctionOfUsageEventId: null, sourceId, billingPeriodId: null,
});
const correction = (id: string, parentId: string, sourceId: string | null = null): UsageSourceEvent => ({
  id, metric: "RECOVERY_CONVERSATION", correctionOfUsageEventId: parentId, sourceId, billingPeriodId: null,
});
const recovery = (id: string, owner = shopId, customerShopId: string | null = shopId) => ({
  id, shopId: owner, customerId: customerShopId ? "customer_a" : null,
  customer: customerShopId ? { shopId: customerShopId, firstName: "Ada", lastName: "Lovelace" } : null,
  conversation: null,
});
function reservation(eventId: string, sourceKey: string, options: { owner?: string; status?: string;
  period?: string } = {}) {
  return {
    shopId: options.owner ?? shopId, status: options.status ?? "COMMITTED",
    committedUsageEventId: eventId, sourceKey,
    billingPeriodEntitlementCounterId: options.period ? "period_counter" : null,
    billingPeriodEntitlementCounter: options.period ? {
      shopId, billingPeriodId: options.period, counter: "INCLUDED_RECOVERY_CREDITS",
    } : null,
  };
}
function fixture(input: {
  reservations?: ReturnType<typeof reservation>[];
  recoveries?: ReturnType<typeof recovery>[];
  attempts?: Array<{ id: string; checkoutRecoveryId: string; checkoutRecovery: { shopId: string } }>;
  parents?: UsageSourceEvent[];
  reservationError?: Error;
} = {}) {
  const calls: Array<{ operation: string; where: unknown }> = [];
  return {
    calls,
    tx: {
      usageEvent: { findMany: async ({ where }: { where: unknown }) => {
        calls.push({ operation: "parents", where }); return input.parents ?? [];
      } },
      usageReservation: { findMany: async ({ where }: { where: unknown }) => {
        calls.push({ operation: "reservations", where });
        if (input.reservationError) throw input.reservationError;
        return input.reservations ?? [];
      } },
      recoveryOutreachAttempt: { findMany: async ({ where }: { where: unknown }) => {
        calls.push({ operation: "attempts", where }); return input.attempts ?? [];
      } },
      checkoutRecovery: { findMany: async ({ where }: { where: unknown }) => {
        calls.push({ operation: "recoveries", where }); return input.recoveries ?? [];
      } },
    },
  };
}

test("Free reservation ID resolves to real same-Shop recovery and customer without sourceId guessing", async () => {
  const { tx, calls } = fixture({
    reservations: [reservation("debit_a", createRecoveryIdempotencyKey(shopId, "recovery_a"))],
    recoveries: [recovery("recovery_a")],
  });
  const mapped = await readUsageRecoverySources(tx as never, shopId, [debit("debit_a", "reservation_a")]);
  assert.deepEqual(mapped.get("debit_a"), { recoveryId: "recovery_a", customerName: "Ada Lovelace" });
  const reservationWhere = calls.find((call) => call.operation === "reservations")?.where;
  assert.deepEqual(reservationWhere, {
    shopId, status: "COMMITTED", committedUsageEventId: { in: ["debit_a"] },
  });
});

test("paid-included reservation resolves through its actual billing period and outreach attempt", async () => {
  const paidKey = `paid-included:period_a:${createRecoveryIdempotencyKey(shopId, "recovery-outreach:attempt_a")}`;
  const { tx, calls } = fixture({
    reservations: [reservation("paid_event", paidKey, { period: "period_a" })],
    attempts: [{ id: "attempt_a", checkoutRecoveryId: "recovery_a", checkoutRecovery: { shopId } }],
    recoveries: [recovery("recovery_a")],
  });
  const mapped = await readUsageRecoverySources(tx as never, shopId, [{ ...debit("paid_event", paidKey), billingPeriodId: "period_a" }]);
  assert.equal(mapped.get("paid_event")?.recoveryId, "recovery_a");
  assert.deepEqual(calls.find((call) => call.operation === "attempts")?.where, {
    id: { in: ["attempt_a"] }, checkoutRecovery: { shopId },
  });
});

test("corrections inherit only a verified original WooCommerce debit recovery", async () => {
  const parent = debit("original", "reservation_a");
  const { tx, calls } = fixture({
    parents: [parent],
    reservations: [reservation("original", createRecoveryIdempotencyKey(shopId, "recovery_a"))],
    recoveries: [recovery("recovery_a"), recovery("unrelated")],
  });
  const mapped = await readUsageRecoverySources(tx as never, shopId,
    [correction("correction_a", "original", "unrelated")]);
  assert.equal(mapped.get("correction_a")?.recoveryId, "recovery_a");
  assert.deepEqual(calls.find((call) => call.operation === "parents")?.where, {
    id: { in: ["original"] }, shopId, provider: "WOOCOMMERCE",
    metric: "RECOVERY_CONVERSATION", correctionOfUsageEventId: null,
  });
});

test("legacy direct links survive, while foreign owner, customer and conflicting evidence fail closed", async () => {
  const { tx } = fixture({
    reservations: [
      reservation("foreign", createRecoveryIdempotencyKey("other", "foreign_recovery"), { owner: "other" }),
      reservation("conflict", createRecoveryIdempotencyKey(shopId, "recovery_a")),
      reservation("reserved", createRecoveryIdempotencyKey(shopId, "recovery_a"), { status: "RESERVED" }),
    ],
    recoveries: [recovery("recovery_a"), recovery("recovery_b"),
      recovery("foreign_recovery", "other"), recovery("wrong_customer", shopId, "other"),
      recovery("guest", shopId, null)],
  });
  const mapped = await readUsageRecoverySources(tx as never, shopId, [
    debit("legacy", "recovery_b"), debit("foreign", "foreign_recovery"),
    debit("conflict", "recovery_b"), debit("reserved", "reservation_reserved"),
    debit("foreign_customer", "wrong_customer"), debit("guest_event", "guest"),
  ]);
  assert.equal(mapped.get("legacy")?.recoveryId, "recovery_b");
  assert.equal(mapped.has("foreign"), false);
  assert.equal(mapped.has("conflict"), false);
  assert.equal(mapped.has("reserved"), false);
  assert.equal(mapped.has("foreign_customer"), false);
  assert.deepEqual(mapped.get("guest_event"), { recoveryId: "guest", customerName: null });
});

test("reservation database errors propagate to the route logger instead of becoming Unlinked", async () => {
  const error = new Error("database_unavailable");
  const { tx } = fixture({ reservationError: error });
  await assert.rejects(readUsageRecoverySources(tx as never, shopId, [debit("debit_a", "reservation_a")]),
    (caught: unknown) => caught === error);
});
