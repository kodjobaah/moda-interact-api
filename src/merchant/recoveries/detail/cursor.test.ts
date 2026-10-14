import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidRecoveryDetailRequest,
  encodeDetailCursor,
  parseDetailNavigation,
  validRecoveryId,
} from "./cursor.js";

const at = new Date("2026-10-09T12:34:56.789Z");

test("cursor is canonical, direction aware, and bound to shop, recovery and section", () => {
  for (const kind of ["messages", "related"] as const) {
    for (const direction of ["next", "previous"] as const) {
      const cursor = encodeDetailCursor("shop_1", "rec_1", kind, direction, { at, id: "item_1" });
      assert.deepEqual(parseDetailNavigation("shop_1", "rec_1", kind, new URLSearchParams({ cursor })), {
        direction, boundary: { at, id: "item_1" },
      });
      for (const [shop, recovery, scope] of [
        ["other", "rec_1", kind], ["shop_1", "other", kind],
        ["shop_1", "rec_1", kind === "related" ? "messages" : "related"],
      ] as const) {
        assert.throws(() => parseDetailNavigation(shop, recovery, scope, new URLSearchParams({ cursor })),
          InvalidRecoveryDetailRequest);
      }
    }
  }
});

test("first/latest windows and all invalid combinations are bounded", () => {
  assert.deepEqual(parseDetailNavigation("shop", "rec", "messages", new URLSearchParams()),
    { direction: "first", boundary: null });
  assert.deepEqual(parseDetailNavigation("shop", "rec", "messages", new URLSearchParams("window=latest")),
    { direction: "latest", boundary: null });
  for (const query of ["window=middle", "window=first&window=latest", "cursor=broken", "cursor=not+/base64",
    "cursor=broken&window=latest", "page=1", "cursor=".concat("x".repeat(1300))]) {
    assert.throws(() => parseDetailNavigation("shop", "rec", "messages", new URLSearchParams(query)),
      InvalidRecoveryDetailRequest);
  }
  assert.throws(() => parseDetailNavigation("shop", "rec", "related", new URLSearchParams("window=latest")),
    InvalidRecoveryDetailRequest);
  for (const id of ["", "a/b", "a%2Fb", "evil?x", "x".repeat(192), "\u0000evil"]) {
    assert.equal(validRecoveryId(id), false);
  }
});

test("modified and noncanonical cursor payloads are rejected", () => {
  const cursor = encodeDetailCursor("shop", "rec", "messages", "next", { at, id: "msg" });
  const obj = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  for (const altered of [{ ...obj, v: 2 }, { ...obj, at: "2026-02-30T11:00:00.000Z" },
    { ...obj, injected: "secret" }, { ...obj, id: "not/a/key" }]) {
    assert.throws(() => parseDetailNavigation("shop", "rec", "messages", new URLSearchParams({
      cursor: Buffer.from(JSON.stringify(altered)).toString("base64url"),
    })), InvalidRecoveryDetailRequest);
  }
  assert.throws(() => parseDetailNavigation("shop", "rec", "messages", new URLSearchParams({
    cursor: cursor.concat("="),
  })), InvalidRecoveryDetailRequest);
});
