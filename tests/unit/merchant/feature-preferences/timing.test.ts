import assert from "node:assert/strict";
import test from "node:test";
import { timeFeaturePhase, timeFeatureSync, type FeaturePreferencesTimings } from "../../../../src/merchant/feature-preferences/timing.js";

test("phase instrumentation records successful synchronous and asynchronous durations", async () => {
  const timings: FeaturePreferencesTimings = {};
  assert.equal(timeFeatureSync(timings, "projectionMs", () => 3), 3);
  assert.equal(await timeFeaturePhase(timings, "shopLookupMs", async () => 4), 4);
  assert.ok(typeof timings.projectionMs === "number" && timings.projectionMs >= 0);
  assert.ok(typeof timings.shopLookupMs === "number" && timings.shopLookupMs >= 0);
  assert.equal(timings.failedPhase, undefined);
});

test("timing never swallows provider errors and retains innermost failed phase", async () => {
  const timings: FeaturePreferencesTimings = {};
  const original = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  await assert.rejects(() => timeFeaturePhase(timings, "transactionMs", () =>
    timeFeaturePhase(timings, "subscriptionLookupMs", async () => { throw original; })),
  (error: unknown) => error === original);
  assert.equal(timings.failedPhase, "subscriptionLookupMs");
  assert.equal(typeof timings.transactionMs, "number");
  assert.equal(typeof timings.subscriptionLookupMs, "number");
  assert.throws(() => timeFeatureSync(timings, "projectionMs", () => { throw original; }), (error: unknown) => error === original);
  assert.equal(timings.failedPhase, "subscriptionLookupMs");
});
