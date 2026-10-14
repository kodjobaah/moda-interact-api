import assert from "node:assert/strict";
import test from "node:test";
import { InvalidRecoveryListQuery, parseRecoveryListQuery, resolveRecoveryTimeZone } from "./query.js";

const NOW = new Date("2026-10-11T19:30:00.000Z");
const parse = (q = "", timeZone = "Europe/London", now = NOW) =>
  parseRecoveryListQuery(new URLSearchParams(q), timeZone, now);

test("defaults to 30 store-local calendar days, 25 records and first page", () => {
  const query = parse();
  assert.equal(query.from, "2026-09-12");
  assert.equal(query.to, "2026-10-11");
  assert.equal(query.timeZone, "Europe/London");
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, 25);
  assert.equal(query.status, "all");
  assert.equal(query.start.toISOString(), "2026-09-11T23:00:00.000Z");
  assert.equal(query.end.toISOString(), "2026-10-11T23:00:00.000Z");
});

test("store-local boundaries account for spring DST and are exclusive at the end", () => {
  const range = parse("from=2026-03-29&to=2026-03-29", "Europe/London", new Date("2026-04-01T11:00:00.000Z"));
  assert.equal(range.start.toISOString(), "2026-03-29T00:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-03-29T23:00:00.000Z");
  assert.equal(range.end.getTime() - range.start.getTime(), 23 * 3600_000);
});

test("store local today can differ from UTC and timezone falls back to UTC", () => {
  const now = new Date("2026-10-11T00:30:00.000Z");
  assert.equal(parse("", "America/Los_Angeles", now).to, "2026-10-10");
  assert.equal(resolveRecoveryTimeZone("Bad/Timezone"), "UTC");
  assert.equal(resolveRecoveryTimeZone(null), "UTC");
  assert.equal(resolveRecoveryTimeZone("Europe/London"), "Europe/London");
});

test("server accepts approved page sizes, specific statuses and name/email search", () => {
  const query = parse("page=2&pageSize=50&status=ongoing&q=%20Ada%20Lovelace%20&from=2026-10-01&to=2026-10-11");
  assert.equal(query.page, 2);
  assert.equal(query.pageSize, 50);
  assert.equal(query.status, "ongoing");
  assert.equal(query.q, "Ada Lovelace");
  assert.equal(parse("pageSize=10&status=DETECTED").status, "DETECTED");
  assert.equal(parse("pageSize=20&status=COMPLETED").pageSize, 20);
});

test("unknown, duplicate and tenant-supplied parameters are rejected", () => {
  for (const query of ["shopId=foreign", "cursor=secret", "from=2026-10-01&from=2026-10-02", "page=1&page=2",
    "unexpected=true", "status=ALL", "page=0", "page=-1", "page=01", "page=10000", "pageSize=100", "pageSize=0",
    "pageSize=025", "q=%00", "q=%1F", "q=%7F", `q=${"x".repeat(101)}`]) {
    assert.throws(() => parse(query), InvalidRecoveryListQuery, query);
  }
});

test("rejects reversed, future, nonexistent and oversized date ranges", () => {
  for (const query of [
    "from=2026-10-12&to=2026-10-11", "from=2026-10-01&to=2026-10-12",
    "from=2026-02-30", "from=2026-10-01T00%3A00Z", "from=2025-01-01&to=2026-10-11",
    "from=2026-01-01&to=2026-12-31", "from=0000-01-01", "to=2026-13-11",
  ]) assert.throws(() => parse(query), InvalidRecoveryListQuery, query);
  assert.equal(parse("from=2025-10-11&to=2026-10-11").to, "2026-10-11");
});
