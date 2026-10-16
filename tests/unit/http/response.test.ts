import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { sendNoStoreJson } from "../../../src/http/response.js";

function fixture(options: { destroyed?: boolean; headersSent?: boolean } = {}) {
  const calls: Array<{ status: number; headers: Record<string, string> }> = [];
  const bodies: string[] = [];
  const response = {
    destroyed: options.destroyed ?? false,
    headersSent: options.headersSent ?? false,
    writeHead(status: number, headers: Record<string, string>) { calls.push({ status, headers }); },
    end(body: string) { bodies.push(body); },
  } as unknown as ServerResponse;
  return { response, calls, bodies };
}

test("sendNoStoreJson preserves the exact no-store JSON response headers and payload", () => {
  const { response, calls, bodies } = fixture();
  sendNoStoreJson(response, 409, { error: "some_conflict" });
  assert.deepEqual(calls, [{
    status: 409,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  }]);
  assert.deepEqual(bodies, ['{"error":"some_conflict"}']);
});

test("sendNoStoreJson does not write when headers were sent or the response was destroyed", () => {
  for (const options of [{ headersSent: true }, { destroyed: true }]) {
    const { response, calls, bodies } = fixture(options);
    sendNoStoreJson(response, 200, { private: "data" });
    assert.deepEqual(calls, []);
    assert.deepEqual(bodies, []);
  }
});
