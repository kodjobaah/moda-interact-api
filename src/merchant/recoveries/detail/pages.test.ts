import assert from "node:assert/strict";
import test from "node:test";
import { parseDetailNavigation } from "./cursor.js";
import { readMessagePage, readRelatedPage } from "./pages.js";

function makeRows(count: number) {
  return Array.from({ length: count }, (_, n) => ({
    id: `item_${String(n).padStart(4, "0")}`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(n / 2))),
    detectedAt: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(n / 2))),
    status: "COMPLETED",
    direction: n % 2 ? "INBOUND" : "OUTBOUND",
    senderType: n % 2 ? "CUSTOMER" : "AGENT",
    contentType: "TEXT",
    content: `Message ${n}`,
    transcriptionStatus: "NOT_REQUIRED",
    sentAt: null, deliveredAt: null, readAt: null,
    totalPrice: { toString: () => String(n + 1) }, currency: "GBP",
  }));
}

/** Minimal query evaluator matching the keyset predicates produced by the readers. */
function execute(rows: ReturnType<typeof makeRows>, where: Record<string, unknown>, dateKey: "createdAt" | "detectedAt") {
  const or = where.OR as Array<Record<string, unknown>> | undefined;
  if (!or) return rows;
  return rows.filter((row) => or.some((branch) => {
    const date = branch[dateKey];
    const value = row[dateKey].getTime();
    if (date instanceof Date) return value === date.getTime() &&
      compare(row.id, branch.id as Record<string, string>);
    const bounds = date as Record<string, Date>;
    if (bounds.lt) return value < bounds.lt.getTime();
    assert.ok(bounds.gt, "Expected a greater-than timestamp boundary");
    return value > bounds.gt.getTime();
  }));
}
function compare(id: string, bound: Record<string, string>) {
  if (bound.lt) return id < bound.lt;
  assert.ok(bound.gt, "Expected a greater-than identifier boundary");
  return id > bound.gt;
}
function mockTx(rows: ReturnType<typeof makeRows>) {
  const find = async (query: {
    where: Record<string, unknown>;
    orderBy: Array<Record<string, string>>;
    take: number;
  }) => {
    const key = "createdAt" in query.orderBy[0]! ? "createdAt" : "detectedAt";
    const descending = query.orderBy[0]![key] === "desc";
    return execute(rows, query.where, key).sort((a, b) => {
      const difference = a[key].getTime() - b[key].getTime() || a.id.localeCompare(b.id);
      return descending ? -difference : difference;
    }).slice(0, query.take);
  };
  const count = async (query: { where: Record<string, unknown> }) => {
    const key = "conversationId" in query.where ? "createdAt" : "detectedAt";
    return execute(rows, query.where, key).length;
  };
  return {
    conversationMessage: { findMany: find, count },
    checkoutRecovery: { findMany: find, count },
  } as never;
}

test("50-item chronological pages have stable cursors across identical timestamps", async () => {
  const tx = mockTx(makeRows(105));
  const first = await readMessagePage(tx, "shop", "rec", "conv", { direction: "first", boundary: null });
  assert.equal(first.items.length, 50);
  assert.equal(first.previousCursor, null);
  assert.ok(first.nextCursor);
  const next = await readMessagePage(tx, "shop", "rec", "conv",
    parseDetailNavigation("shop", "rec", "messages", new URLSearchParams({ cursor: first.nextCursor! })));
  assert.equal(next.items.length, 50);
  assert.ok(next.nextCursor);
  assert.ok(next.previousCursor);
  const last = await readMessagePage(tx, "shop", "rec", "conv",
    parseDetailNavigation("shop", "rec", "messages", new URLSearchParams({ cursor: next.nextCursor! })));
  assert.equal(last.items.length, 5);
  assert.equal(last.nextCursor, null);
  const allIds = [...first.items, ...next.items, ...last.items].map((row) => row.id);
  assert.equal(new Set(allIds).size, 105);
  const backwards = await readMessagePage(tx, "shop", "rec", "conv",
    parseDetailNavigation("shop", "rec", "messages", new URLSearchParams({ cursor: last.previousCursor! })));
  assert.deepEqual(backwards.items.map((row) => row.id), next.items.map((row) => row.id));
});

test("latest window shows most recent 50, with older-page navigation", async () => {
  const tx = mockTx(makeRows(105));
  const latest = await readMessagePage(tx, "shop", "rec", "conv", { direction: "latest", boundary: null });
  assert.equal(latest.items.length, 50);
  assert.equal(latest.nextCursor, null);
  assert.ok(latest.previousCursor);
  assert.equal(latest.items[49]?.id, "item_0104");
});

test("related recoveries use independent five-item newest-first pages", async () => {
  const tx = mockTx(makeRows(12));
  const first = await readRelatedPage(tx, "shop", "rec", "customer", { direction: "first", boundary: null });
  assert.equal(first.items.length, 5);
  assert.ok(first.nextCursor);
  assert.equal(first.previousCursor, null);
  const next = await readRelatedPage(tx, "shop", "rec", "customer",
    parseDetailNavigation("shop", "rec", "related", new URLSearchParams({ cursor: first.nextCursor! })));
  const last = await readRelatedPage(tx, "shop", "rec", "customer",
    parseDetailNavigation("shop", "rec", "related", new URLSearchParams({ cursor: next.nextCursor! })));
  assert.equal(last.items.length, 2);
  assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.items, ...next.items, ...last.items].map((row) => row.id)).size, 12);
  const back = await readRelatedPage(tx, "shop", "rec", "customer",
    parseDetailNavigation("shop", "rec", "related", new URLSearchParams({ cursor: last.previousCursor! })));
  assert.deepEqual(back.items.map((row) => row.id), next.items.map((row) => row.id));
});
