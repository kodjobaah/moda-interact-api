import assert from "node:assert/strict";
import test from "node:test";
import { createSingleFlightReadinessProbe } from "../../../src/readiness-probe.js";

function barrier() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test("one pending delegate is shared and a rejection permits a fresh probe", async () => {
  const held = barrier();
  const failure = new Error("database unavailable");
  let calls = 0;
  const probe = createSingleFlightReadinessProbe(() => ++calls === 1 ? held.promise : Promise.resolve());
  const first = probe();
  for (let i = 0; i < 24; i++) assert.equal(probe(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  held.reject(failure);
  await assert.rejects(first, error => error === failure);
  await probe();
  await probe();
  assert.equal(calls, 3);
});

test("synchronous delegate failures also release the guard", async () => {
  const failure = new Error("failed synchronously");
  const probe = createSingleFlightReadinessProbe(() => { throw failure; });
  const first = probe();
  await assert.rejects(first, error => error === failure);
  const second = probe();
  assert.notEqual(second, first);
  await assert.rejects(second, error => error === failure);
});
