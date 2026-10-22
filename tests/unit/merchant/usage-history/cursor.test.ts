import assert from "node:assert/strict";
import test from "node:test";
import { decodePeriodCursor, encodePeriodCursor } from "../../../../src/merchant/usage-history/cursor.js";
import { UsageHistoryRequestError } from "../../../../src/merchant/usage-history/contract.js";

const key = Buffer.alloc(32, 9);
const date = new Date("2026-08-22T12:00:00.000Z");

test("period seek cursors are signed, scoped to Shop, view, and rotated installation", () => {
  const original = { direction: "next" as const, start: date, id: "period_09" };
  const token = encodePeriodCursor("shop_a", "past", original, key);
  assert.deepEqual(decodePeriodCursor(token, "shop_a", "past", key), original);
  for (const wrong of [
    () => decodePeriodCursor(token, "shop_b", "past", key),
    () => decodePeriodCursor(token, "shop_a", "current", key),
    () => decodePeriodCursor(token, "shop_a", "past", Buffer.alloc(32, 10)),
    () => decodePeriodCursor(token.slice(0, -2) + "aa", "shop_a", "past", key),
    () => decodePeriodCursor("../fake", "shop_a", "past", key),
    () => decodePeriodCursor("broken", "shop_a", "past", key),
  ]) assert.throws(wrong, UsageHistoryRequestError);
  const envelope = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8"));
  payload.start = "2026-10-01T00:00:00.000Z";
  const modified = Buffer.from(JSON.stringify({ ...envelope, payload: Buffer.from(JSON.stringify(payload)).toString("base64url") })).toString("base64url");
  assert.throws(() => decodePeriodCursor(modified, "shop_a", "past", key), UsageHistoryRequestError);
});
