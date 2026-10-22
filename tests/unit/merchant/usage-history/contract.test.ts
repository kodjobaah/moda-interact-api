import assert from "node:assert/strict";
import test from "node:test";
import { parseUsageHistoryQuery, UsageHistoryRequestError } from "../../../../src/merchant/usage-history/contract.js";
import { isUsageHistoryResponse } from "../../../../src/merchant/usage-history/schema.js";

const defaults = { view: "current", periodId: null, kind: "ALL", page: 1, pageSize: 10, periodCursor: null };

test("strict Woo Usage History query: defaults, bounded filters, no tenant selector", () => {
  assert.deepEqual(parseUsageHistoryQuery(new URLSearchParams()), defaults);
  assert.deepEqual(parseUsageHistoryQuery(new URLSearchParams(
    "view=past&periodId=period_123&kind=RECOVERY_CONVERSATION&page=1000&pageSize=100&periodCursor=abc_12",
  )), { view: "past", periodId: "period_123", kind: "RECOVERY_CONVERSATION",
    page: 1000, pageSize: 100, periodCursor: "abc_12" });
  for (const pageSize of [10, 25, 50, 100]) assert.equal(parseUsageHistoryQuery(new URLSearchParams(`pageSize=${pageSize}`)).pageSize, pageSize);
  for (const query of ["shopId=other", "kind=ALL&kind=RECOVERY_CONVERSATION", "page=1&page=2",
    "view=other", "kind=BOGUS", "page=0", "page=1001", "page=01", "page=-1", "page=Infinity",
    "pageSize=1", "pageSize=010", "pageSize=101", "periodId=", "periodId=abc.def", "periodId=a%2Fb",
    `periodId=${"a".repeat(129)}`, "periodCursor=%2Babc", `periodCursor=${"b".repeat(1025)}`]) {
    assert.throws(() => parseUsageHistoryQuery(new URLSearchParams(query)), UsageHistoryRequestError, query);
  }
});

const response = {
  schemaVersion: 1, state: "ready", usageView: "past",
  periodPage: { items: [{ id: "period_1", periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z" }],
    previousCursor: null, nextCursor: null },
  usageEvents: [{ id: "event_2", metric: "RECOVERY_CONVERSATION", quantity: -1,
    occurredAt: "2026-09-23T01:00:00.000Z", sourceRecovery: { recoveryId: "recovery_1", customerName: "Customer" } }],
  usagePagination: { page: 1, pageSize: 10, total: 1, totalQuantity: -1, billId: "period_1",
    periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z" },
};

test("response contract keeps signed corrections and rejects leaked/private fields", () => {
  assert.equal(isUsageHistoryResponse(response), true);
  assert.equal(isUsageHistoryResponse({ ...response, shopId: "shop_other" }), false);
  assert.equal(isUsageHistoryResponse({ ...response, usageEvents: [{ ...response.usageEvents[0], idempotencyKey: "secret" }] }), false);
  assert.equal(isUsageHistoryResponse({ ...response, usageEvents: [{ ...response.usageEvents[0], quantity: Number.MAX_VALUE }] }), false);
  assert.equal(isUsageHistoryResponse({ ...response, usagePagination: { ...response.usagePagination, totalQuantity: Infinity } }), false);
  assert.equal(isUsageHistoryResponse({ ...response, usageEvents: [{ ...response.usageEvents[0], sourceRecovery: {
    recoveryId: "recovery_1", customerName: "Test", email: "sensitive@example.test",
  } }] }), false);
  assert.equal(isUsageHistoryResponse({ ...response, periodPage: { ...response.periodPage, items: Array(26).fill(response.periodPage.items[0]) } }), false);
  assert.equal(isUsageHistoryResponse({ ...response, periodPage: { ...response.periodPage, items: [{
    ...response.periodPage.items[0], periodStart: "not-a-date",
  }] } }), false);
});


test("Free lifetime response accepts genuinely absent period boundaries", () => {
  const free = {
    ...response,
    usageView: "current",
    periodPage: { items: [], previousCursor: null, nextCursor: null },
    usageEvents: [],
    usagePagination: {
      ...response.usagePagination,
      total: 0,
      totalQuantity: 0,
      billId: null,
      periodStart: null,
      periodEnd: null,
    },
  };
  assert.equal(isUsageHistoryResponse(free), true);
  assert.equal(isUsageHistoryResponse({
    ...free,
    usagePagination: { ...free.usagePagination, periodEnd: response.usagePagination.periodEnd },
  }), false);
});
