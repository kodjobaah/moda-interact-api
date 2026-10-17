import assert from "node:assert/strict";
import test from "node:test";
import {
  FeaturePreferencesRequestError, isFeaturePreferencesResponse, parseFeaturePreferencesUpdate,
} from "../../../../src/merchant/feature-preferences/contract.js";

const revision = "a".repeat(64);
const feature = { id: "f1", key: "feature_one", name: "Feature", description: null,
  enabled: false, effective: false, editable: true, required: false, planEligible: true };

test("strict request allows bounded distinct changes and empty no-op", () => {
  assert.deepEqual(parseFeaturePreferencesUpdate({ expectedRevision: revision, changes: [{ featureId: "f1", enabled: true }] }),
    { expectedRevision: revision, changes: [{ featureId: "f1", enabled: true }] });
  assert.deepEqual(parseFeaturePreferencesUpdate({ expectedRevision: revision, changes: [] }).changes, []);
});

test("strict request rejects unknown, foreign, duplicate, malformed and excessive inputs", () => {
  for (const input of [null, [], {}, { expectedRevision: "0", changes: [] },
    { expectedRevision: revision, changes: [], shopId: "other" },
    { expectedRevision: revision, preferences: [{ featureId: "f1", enabled: true }] },
    { expectedRevision: revision, changes: [{ featureId: "f1", enabled: 1 }] },
    { expectedRevision: revision, changes: [{ featureId: "f1", enabled: true, shopId: "other" }] },
    { expectedRevision: revision, changes: [{ featureId: "f1", enabled: true }, { featureId: "f1", enabled: false }] },
    { expectedRevision: revision, changes: [{ featureId: "f".repeat(129), enabled: true }] },
    { expectedRevision: revision, changes: Array.from({ length: 1001 }, (_, i) => ({ featureId: `f${i}`, enabled: true })) },
  ]) assert.throws(() => parseFeaturePreferencesUpdate(input), FeaturePreferencesRequestError);
});

test("strict response contains required and plan eligibility, never raw DB fields", () => {
  assert.equal(isFeaturePreferencesResponse({ schemaVersion: 1, revision, features: [feature] }), true);
  for (const bad of [
    { ...feature, secret: "private" }, { ...feature, planEligible: false, effective: true },
    { ...feature, planEligible: false, editable: true }, { ...feature, required: true, editable: true },
    { ...feature, required: undefined },
  ]) assert.equal(isFeaturePreferencesResponse({ schemaVersion: 1, revision, features: [bad] }), false);
  assert.equal(isFeaturePreferencesResponse({ schemaVersion: 1, revision, features: [feature, feature] }), false);
});
