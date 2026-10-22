import assert from "node:assert/strict";
import test from "node:test";
import { readPeriodPage } from "../../../../src/merchant/usage-history/periods.js";
import { encodePeriodCursor } from "../../../../src/merchant/usage-history/cursor.js";
import { UsageHistoryRequestError } from "../../../../src/merchant/usage-history/contract.js";

const key = Buffer.alloc(32, 1);
const periods = Array.from({ length: 53 }, (_, n) => ({
  id: `period_${String(n).padStart(3, "0")}`, shopId: "shop_1", subscriptionId: "subscription_1",
  planKindSnapshot: "PAID_METERED", status: "CLOSED",
  periodStart: new Date(Date.UTC(2025, 0, 1 + n)),
  periodEnd: new Date(Date.UTC(2025, 0, 2 + n)),
}));
const byDescending = [...periods].reverse();
function db() {
  return { billingPeriod: {
    findFirst: async ({ where }: { where: { id: string; shopId: string; status: string; periodStart: Date } }) =>
      periods.find((p) => p.id === where.id && p.shopId === where.shopId &&
        p.status === where.status && p.periodStart.getTime() === where.periodStart.getTime()) ?? null,
    findMany: async ({ where, orderBy, take }: { where: { OR?: Array<Record<string, unknown>> }; orderBy: Array<Record<string, string>>; take: number }) => {
      const newest = orderBy[0]?.periodStart === "asc";
      let rows = newest ? [...periods] : [...byDescending];
      if (where.OR) {
        const startClause = where.OR[0]?.periodStart as { lt?: Date; gt?: Date };
        const idClause = where.OR[1] as { periodStart: Date; id: { lt?: string; gt?: string } };
        rows = rows.filter((row) => newest
          ? row.periodStart > startClause.gt! || (row.periodStart.getTime() === idClause.periodStart.getTime() && row.id > idClause.id.gt!)
          : row.periodStart < startClause.lt! || (row.periodStart.getTime() === idClause.periodStart.getTime() && row.id < idClause.id.lt!));
      }
      return rows.slice(0, take);
    },
  } };
}

async function page(token: string | null) {
  return readPeriodPage(db() as never, { shopId: "shop_1", view: "past", cursor: token, key, currentPeriod: null });
}

test("closed periods seek backwards/forwards by (periodStart DESC, id DESC), max 25", async () => {
  const first = await page(null);
  assert.deepEqual(first.items.map((x) => x.id), byDescending.slice(0, 25).map((x) => x.id));
  assert.equal(first.previousCursor, null);
  assert.ok(first.nextCursor);
  const second = await page(first.nextCursor);
  assert.deepEqual(second.items.map((x) => x.id), byDescending.slice(25, 50).map((x) => x.id));
  assert.ok(second.nextCursor);
  const third = await page(second.nextCursor);
  assert.deepEqual(third.items.map((x) => x.id), byDescending.slice(50).map((x) => x.id));
  assert.equal(third.nextCursor, null);
  const back = await page(third.previousCursor);
  assert.deepEqual(back.items.map((x) => x.id), second.items.map((x) => x.id));
  assert.deepEqual((await page(back.previousCursor)).items, first.items);
});

test("nonexistent signed period anchor and inappropriate current cursor are rejected", async () => {
  const forged = encodePeriodCursor("shop_1", "past", {
    direction: "next", start: new Date("2024-01-01T00:00:00.000Z"), id: "nonexistent",
  }, key);
  await assert.rejects(page(forged), UsageHistoryRequestError);
  await assert.rejects(readPeriodPage(db() as never, {
    shopId: "shop_1", view: "current", cursor: forged, key, currentPeriod: null,
  }), UsageHistoryRequestError);
});
