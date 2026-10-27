import assert from "node:assert/strict";
import test from "node:test";
import { isRecoveryPolicyResponse, parseRecoveryPolicyUpdate, RecoveryPolicyRequestError } from "../../../../src/merchant/recovery-policy/contract.js";

const valid = { expectedRevision: "UNCONFIGURED", recoveryDelayMinutes: 30,
  followUpEnabled: false, followUpDelayMinutes: null, notifyOnInitialRecoveryOutreach: false };

test("only five approved merchant fields may be written (no shopId, offer or override)", () => {
  assert.deepEqual(parseRecoveryPolicyUpdate(valid), valid);
  for (const property of ["shopId", "recoveryOfferMode", "fixedShopifyDiscountId", "source", "reason", "platformAdminId"]) {
    assert.throws(() => parseRecoveryPolicyUpdate({ ...valid, [property]: "foreign" }), RecoveryPolicyRequestError);
  }
  for (const notifyOnInitialRecoveryOutreach of [undefined, "true", 1, null]) {
    assert.throws(() => parseRecoveryPolicyUpdate({ ...valid, notifyOnInitialRecoveryOutreach }), RecoveryPolicyRequestError);
  }
});

test("recovery start and follow-up validate strict integer boundaries", () => {
  for (const minutes of [0, 30, 10080]) assert.equal(parseRecoveryPolicyUpdate({ ...valid, recoveryDelayMinutes: minutes }).recoveryDelayMinutes, minutes);
  for (const minutes of [-1, 10081, 1.5, "30", null, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => parseRecoveryPolicyUpdate({ ...valid, recoveryDelayMinutes: minutes }), RecoveryPolicyRequestError);
  }
  for (const minutes of [1, 60, 10080]) assert.equal(parseRecoveryPolicyUpdate({ ...valid, followUpEnabled: true, followUpDelayMinutes: minutes }).followUpDelayMinutes, minutes);
  for (const minutes of [null, 0, -1, 10081, 1.5, "50", "", undefined]) {
    assert.throws(() => parseRecoveryPolicyUpdate({ ...valid, followUpEnabled: true, followUpDelayMinutes: minutes }), RecoveryPolicyRequestError);
  }
  assert.throws(() => parseRecoveryPolicyUpdate({ ...valid, followUpEnabled: false, followUpDelayMinutes: 5 }), RecoveryPolicyRequestError);
});

test("revision must be the previous canonical revision or UNCONFIGURED", () => {
  const stamp = "2026-10-12T10:00:00.001Z";
  assert.equal(parseRecoveryPolicyUpdate({ ...valid, expectedRevision: stamp }).expectedRevision, stamp);
  for (const expectedRevision of ["", "latest", "2026-99-12T10:00:00.001Z", "2026-10-12T10:00:00Z", null]) {
    assert.throws(() => parseRecoveryPolicyUpdate({ ...valid, expectedRevision }), RecoveryPolicyRequestError);
  }
});

test("response validates exact DTO without leaking stored Shopify identifiers", () => {
  const base = { recoveryDelayMinutes: 30, recoveryOfferMode: "NONE", followUpEnabled: false, followUpDelayMinutes: null };
  const good = { schemaVersion: 2, revision: "UNCONFIGURED", merchant: base, effective: base,
    source: "MERCHANT", overrideActive: false, offerSelectionAvailable: false,
    notifyOnInitialRecoveryOutreach: false };
  assert.equal(isRecoveryPolicyResponse(good), true);
  assert.equal(isRecoveryPolicyResponse({ ...good, secret: "private" }), false);
  assert.equal(isRecoveryPolicyResponse({ ...good, merchant: { ...base, fixedShopifyDiscountId: "private" } }), false);
  assert.equal(isRecoveryPolicyResponse({ ...good, source: "ADMIN_OVERRIDE" }), false);
  assert.equal(isRecoveryPolicyResponse({ ...good, schemaVersion: 1 }), false);
  assert.equal(isRecoveryPolicyResponse({ ...good, notifyOnInitialRecoveryOutreach: "false" }), false);
  assert.equal(isRecoveryPolicyResponse({ ...good, merchant: { ...base, recoveryDelayMinutes: 10081 } }), false);
  assert.equal(isRecoveryPolicyResponse({ ...good, effective: { ...base, recoveryOfferMode: "FIXED" }, source: "ADMIN_OVERRIDE", overrideActive: true }), true);
});
