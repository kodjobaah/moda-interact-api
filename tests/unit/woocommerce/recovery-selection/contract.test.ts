import assert from "node:assert/strict";
import test from "node:test";
import { parseCanonicalPhone, parseWooRecoverySelectionChange,
  WOO_RECOVERY_SELECTION_VERSION } from "../../../../src/woocommerce/recovery-selection/contract.js";

const basic = { schemaVersion: WOO_RECOVERY_SELECTION_VERSION,
  canonicalPhone: "447400123467", action: "SUPPRESS", expectedNoContactRevision: "0", evidenceReference: null };

test("strictly accept versioned revision-bound merchant commands, never a shop/customer override", () => {
  assert.deepEqual(parseWooRecoverySelectionChange(basic), basic);
  assert.deepEqual(parseWooRecoverySelectionChange({ ...basic, action: "RECORD_CUSTOMER_STOP",
    evidenceReference: "support:merchant-email-123" }).action, "RECORD_CUSTOMER_STOP");
  for (const invalid of [
    { ...basic, shopId: "another-shop" }, { ...basic, customerId: "other" },
    { ...basic, expectedNoContactRevision: -1 }, { ...basic, expectedNoContactRevision: "01" },
    { ...basic, expectedNoContactRevision: "9223372036854775808" },
    { ...basic, expectedNoContactRevision: "1e2" }, { ...basic, canonicalPhone: "+447400123467" },
    { ...basic, canonicalPhone: "000" }, { ...basic, canonicalPhone: "447400123467\n" },
    { ...basic, action: "GRANT" }, { ...basic, evidenceReference: "customer said stop" },
    { ...basic, action: "RECORD_CUSTOMER_STOP" },
    { ...basic, action: "REENABLE", evidenceReference: "support:123" },
  ]) {
    assert.throws(() => parseWooRecoverySelectionChange(invalid));
  }
  assert.equal(parseCanonicalPhone("12135551234"), "12135551234");
});
