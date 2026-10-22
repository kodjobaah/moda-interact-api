import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { recoverySourceFromReservationKey } from "../../../../src/merchant/usage-history/reservation-source-key.js";

const shopId = "shop_test_1";
function reservation(sourceKey: string, periodId: string | null = null, owner = shopId) {
  return {
    shopId: owner, sourceKey,
    billingPeriodEntitlementCounterId: periodId ? "period_counter" : null,
    billingPeriodEntitlementCounter: periodId ? {
      shopId: owner, billingPeriodId: periodId, counter: "INCLUDED_RECOVERY_CREDITS",
    } : null,
  };
}

test("canonical Shared keys locate recovery and outreach attempts", () => {
  assert.deepEqual(recoverySourceFromReservationKey(
    reservation(createRecoveryIdempotencyKey(shopId, "recovery_123")), shopId),
  { kind: "recovery", id: "recovery_123" });
  assert.deepEqual(recoverySourceFromReservationKey(reservation(
    createRecoveryIdempotencyKey(shopId, "recovery-outreach:attempt_123")), shopId),
  { kind: "outreach", id: "attempt_123" });
  assert.deepEqual(recoverySourceFromReservationKey(reservation(
    `paid-included:period_a:${createRecoveryIdempotencyKey(shopId, "recovery-outreach:attempt_a")}`,
    "period_a"), shopId),
  { kind: "outreach", id: "attempt_a" });
});

test("invalid or unverifiable reservation keys cannot become links", () => {
  const valid = createRecoveryIdempotencyKey(shopId, "recovery_123");
  for (const sourceKey of [
    valid, `paid-included:period_bad:${valid}`, `recovery:${shopId}:recovery-outreach:`,
    `recovery:${shopId}:h1234567890abcdef`, `recovery:other_shop:recovery_123`,
    `recovery:${shopId}:fake:segment`, "fixture-without-proven-link",
  ]) {
    const chosen = sourceKey === valid
      ? reservation(sourceKey, null, "foreign_shop")
      : sourceKey.startsWith("paid-included:") ? reservation(sourceKey, "period_a") : reservation(sourceKey);
    assert.equal(recoverySourceFromReservationKey(chosen, shopId), null, sourceKey);
  }
  assert.equal(recoverySourceFromReservationKey({
    ...reservation(`paid-included:period_a:${valid}`, "period_a"),
    billingPeriodEntitlementCounter: { shopId, billingPeriodId: "period_a", counter: "OTHER" },
  }, shopId), null);
});
