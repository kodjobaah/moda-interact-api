import assert from "node:assert/strict";
import test from "node:test";
import { parseWooConsentStatusProbe, WOO_CONSENT_STATUS_VERSION,
  WooConsentStatusHttpError } from "../../../../src/woocommerce/consent-status/contract.js";

const valid = { schemaVersion: WOO_CONSENT_STATUS_VERSION,
  canonicalPhone: "447400123456", grantEventId: "woo-consent-01" };
const invalid = (error: unknown) => error instanceof WooConsentStatusHttpError && error.code === "invalid_request";

test("status-v1 accepts only the existing Woo server-held GRANT proof shape", () => {
  assert.deepEqual(parseWooConsentStatusProbe(valid), valid);
  for (const value of [
    {}, { ...valid, shopId: "other" }, { ...valid, customerId: "other" },
    { ...valid, installationId: "other" }, { ...valid, schemaVersion: "woo.whatsapp-consent.v2" },
    { ...valid, canonicalPhone: "+447400123456" }, { ...valid, canonicalPhone: "123!" }, { ...valid, canonicalPhone: "12" },
    { ...valid, grantEventId: "bad event" }, { ...valid, grantEventId: "" },
    { ...valid, grantEventId: "a".repeat(129) }, { ...valid, grantEventId: null },
    { ...valid, canonicalPhone: null }, [], null,
  ]) assert.throws(() => parseWooConsentStatusProbe(value), invalid);
});
