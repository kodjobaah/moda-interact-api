import assert from "node:assert/strict";
import test from "node:test";
import { readUsageChargeSources } from "../../../../src/merchant/usage-history/attribution.js";

const shopId = "shop_woo";
const periodId = "period_paid";
function event(id: string, overrides: object = {}) {
  return { id, metric: "RECOVERY_CONVERSATION", billingPeriodId: null,
    correctionOfUsageEventId: null, ...overrides };
}
function reservation(id: string, overrides: object = {}) {
  return {
    shopId, status: "COMMITTED", committedUsageEventId: id, compensationUsageEventId: null,
    counterId: null, counter: null, billingPeriodEntitlementCounterId: null,
    billingPeriodEntitlementCounter: null, purchasedCreditPurchaseId: null,
    purchasedCreditPurchase: null, promotionalCreditGrantId: null, promotionalCreditGrant: null,
    ...overrides,
  };
}
function stub(rows: object[], parents: object[] = []) {
  const calls: Array<{ model: string; where: Record<string, unknown> }> = [];
  return {
    tx: {
      usageEvent: { async findMany({ where }: { where: Record<string, unknown> }) {
        calls.push({ model: "usageEvent", where }); return parents;
      } },
      usageReservation: { async findMany({ where }: { where: Record<string, unknown> }) {
        calls.push({ model: "usageReservation", where }); return rows;
      } },
    }, calls,
  };
}

const free = { counterId: "ctr_free", counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } };
const paid = { billingPeriodEntitlementCounterId: "ctr_paid", billingPeriodEntitlementCounter: {
  shopId, counter: "INCLUDED_RECOVERY_CREDITS", billingPeriodId: periodId,
} };
const purchased = { counterId: "ctr_purchased", counter: { shopId, counter: "PURCHASED_RECOVERY_CREDITS" },
  purchasedCreditPurchaseId: "lot_1", purchasedCreditPurchase: { shopId } };
const promotional = { promotionalCreditGrantId: "grant_1", promotionalCreditGrant: { shopId } };

test("classifies each proven credit allocation, including purchased lot plus counter", async () => {
  const events = [event("free"), event("paid", { billingPeriodId: periodId }),
    event("purchased"), event("promotional")];
  const { tx, calls } = stub([
    reservation("free", free), reservation("paid", paid), reservation("purchased", purchased),
    reservation("promotional", promotional),
  ]);
  const result = await readUsageChargeSources(tx as never, shopId, events);
  assert.deepEqual([...result.values()], [
    "LIFETIME_FREE_CREDITS", "INCLUDED_PLAN_ALLOWANCE", "PURCHASED_TOP_UP", "PROMOTIONAL_CREDITS",
  ]);
  assert.deepEqual(calls.map(({ model }) => model), ["usageReservation"]);
  assert.equal(calls[0]?.where.shopId, shopId);
  assert.equal(JSON.stringify([...result]).includes("lot_1"), false);
});

test("signed corrections inherit the original committed allocation including compensation", async () => {
  const events = [event("correction", { correctionOfUsageEventId: "original" })];
  const { tx, calls } = stub([
    reservation("original", { ...purchased, compensationUsageEventId: "correction" }),
  ], [event("original")]);
  const result = await readUsageChargeSources(tx as never, shopId, events);
  assert.equal(result.get("correction"), "PURCHASED_TOP_UP");
  assert.deepEqual(calls.map(({ model }) => model), ["usageEvent", "usageReservation"]);
  assert.equal(calls[0]?.where.shopId, shopId);
  assert.equal(calls[0]?.where.provider, "WOOCOMMERCE");
  assert.equal(calls[1]?.where.shopId, shopId);
});

test("ordinary corrections without compensation reservation still inherit valid original allocation", async () => {
  const { tx } = stub([reservation("original", free)], [event("original")]);
  const result = await readUsageChargeSources(tx as never, shopId,
    [event("correction", { correctionOfUsageEventId: "original" })]);
  assert.equal(result.get("correction"), "LIFETIME_FREE_CREDITS");
});

test("unlinked and contradictory evidence remains unattributed, never inferred from period or sourceType", async () => {
  const events = [
    event("unlinked", { billingPeriodId: periodId }),
    event("uncommitted"), event("foreign"), event("inconsistent"), event("lost_lot"),
    event("wrong_period", { billingPeriodId: "other_period" }),
    event("multi"), event("wrong_promo"),
    event("purchase_metric", { metric: "RECOVERY_CREDIT_PACK_PURCHASE" }),
  ];
  const { tx } = stub([
    reservation("uncommitted", { ...free, status: "RESERVED" }),
    reservation("foreign", { ...free, counter: { shopId: "other", counter: "LIFETIME_FREE_RECOVERY_CREDITS" } }),
    reservation("inconsistent", { ...free, promotionalCreditGrantId: "grant", promotionalCreditGrant: { shopId } }),
    reservation("lost_lot", { ...purchased, purchasedCreditPurchase: null }),
    reservation("wrong_period", paid),
    reservation("multi", { ...paid, counterId: "counter_2", counter: { shopId, counter: "PURCHASED_RECOVERY_CREDITS" } }),
    reservation("wrong_promo", { ...promotional, promotionalCreditGrant: { shopId: "foreign" } }),
  ]);
  const result = await readUsageChargeSources(tx as never, shopId, events);
  assert.deepEqual([...result.values()], [
    "UNATTRIBUTED", "UNATTRIBUTED", "UNATTRIBUTED", "UNATTRIBUTED", "UNATTRIBUTED",
    "UNATTRIBUTED", "UNATTRIBUTED", "UNATTRIBUTED", "NOT_APPLICABLE",
  ]);
});

test("foreign/missing originals, correction chains and mismatched compensation cannot borrow a charge source", async () => {
  const corrections = [
    event("foreign_correction", { correctionOfUsageEventId: "foreign_original" }),
    event("chain", { correctionOfUsageEventId: "correction_parent" }),
    event("mismatch", { correctionOfUsageEventId: "original" }),
  ];
  const { tx } = stub([
    reservation("original", free),
    reservation("other_original", { ...purchased, compensationUsageEventId: "mismatch" }),
  ], [event("correction_parent", { correctionOfUsageEventId: "initial" }), event("original")]);
  const result = await readUsageChargeSources(tx as never, shopId, corrections);
  assert.ok([...result.values()].every((value) => value === "UNATTRIBUTED"));
});

test("no events causes no database queries, and multiple reservation matches fail closed", async () => {
  const { tx, calls } = stub([reservation("one", free), reservation("one", purchased)]);
  assert.equal((await readUsageChargeSources(tx as never, shopId, [])).size, 0);
  assert.equal(calls.length, 0);
  assert.equal((await readUsageChargeSources(tx as never, shopId, [event("one")])).get("one"), "UNATTRIBUTED");
});
