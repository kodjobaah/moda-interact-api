import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { singleHeader } from "../../../src/http/headers.js";

function request(rawHeaders: string[]): IncomingMessage {
  return { rawHeaders } as IncomingMessage;
}

test("singleHeader preserves raw-field casing, multiplicity and the original value", () => {
  assert.deepEqual(singleHeader(request(["Content-Type", "application/json"]), "content-type"), {
    count: 1,
    value: "application/json",
  });
  assert.deepEqual(singleHeader(request(["CONTENT-TYPE", "one", "content-type", "two"]), "content-type"), {
    count: 2,
  });
  assert.deepEqual(singleHeader(request(["Idempotency-Key", "key1", "idempotency-key", "key2"]), "idempotency-key"), {
    count: 2,
  });
});

test("singleHeader returns no value when absent or when the raw field has no value", () => {
  assert.deepEqual(singleHeader(request(["Accept", "application/json"]), "content-type"), { count: 0 });
  assert.deepEqual(singleHeader(request(["Content-Type"]), "content-type"), { count: 0 });
  assert.deepEqual(singleHeader(request(["Content-Type", "", "content-type", "second"]), "content-type"), {
    count: 2,
  });
});

test("singleHeader does not expose the first credential from duplicated raw fields", () => {
  const result = singleHeader(request(["Authorization", "Bearer sensitive", "AUTHORIZATION", "Bearer second"]), "authorization");
  assert.equal(result.count, 2);
  assert.equal("value" in result, false);
});
