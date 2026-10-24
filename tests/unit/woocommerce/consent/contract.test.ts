import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseWooConsentEvent, WooConsentHttpError, WOO_CONSENT_VERSION } from "../../../../src/woocommerce/consent/contract.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";

const rejected = (value: unknown) => assert.throws(() => parseWooConsentEvent(value),
  (error: unknown) => error instanceof WooConsentHttpError && error.status === 400);

test("v2-only consent GRANT and explicit REVOKE have six fields", () => {
  const grant = consentEvent();
  const revoke = consentEvent({ eventId: "woo-revoke-002", decision: "REVOKE", disclosure: null });
  assert.deepEqual(parseWooConsentEvent(grant), grant);
  assert.deepEqual(parseWooConsentEvent(revoke), revoke);
  assert.equal(grant.schemaVersion, WOO_CONSENT_VERSION);
  for (const [name, mode] of [["grant", "GRANT"], ["revoke", "REVOKE"]] as const) {
    const fixture = JSON.parse(readFileSync(`tests/contracts/woocommerce/consent-${name}.v2.json`, "utf8")) as unknown;
    assert.deepEqual(parseWooConsentEvent(fixture), fixture);
    assert.equal(parseWooConsentEvent(fixture).decision, mode);
  }
});

test("old v1 requests, checkout attestations, browser identity and duplicate phone are not accepted", () => {
  const grant = consentEvent();
  for (const extra of ["shopId", "customerId", "purpose", "checkoutAction", "checkoutMode",
    "checkoutKey", "source", "fieldId", "selection", "userInitiated", "nonceVerified",
    "sessionVerified", "merchantSiteUrl", "serverObservedPhone", "verifiedCountryCode"]) {
    rejected({ ...grant, [extra]: "spoofed" });
  }
  for (const broken of [
    { ...grant, schemaVersion: "woo.whatsapp-consent.v1" },
    { ...grant, schemaVersion: "woo.whatsapp-consent.v9" },
    { ...grant, eventId: "" },
    { ...grant, eventId: "invalid/id" },
    { ...grant, canonicalPhone: "+447400123456" },
    { ...grant, canonicalPhone: "0123" },
    { ...grant, canonicalPhone: "1234567890123456" },
    { ...grant, occurredAt: "2026-02-30T12:00:00.000Z" },
    { ...grant, disclosure: null },
    { ...grant, disclosure: { ...grant.disclosure, merchantSiteUrl: "https://woo.example" } },
    { ...grant, disclosure: { ...grant.disclosure, version: "utility" } },
    { ...grant, disclosure: { ...grant.disclosure, locale: "not_a_locale" } },
    { ...grant, disclosure: { ...grant.disclosure, text: "" } },
    { ...grant, disclosure: { ...grant.disclosure, text: "bad\u0001" } },
    { ...grant, decision: "REVOKE", disclosure: grant.disclosure },
    { ...grant, decision: "REVOKE", disclosure: undefined },
  ]) rejected(broken);
});

test("localized disclosure wording is preserved without URL/name/keyword matching", () => {
  const grant = consentEvent();
  for (const [version, locale, text] of [
    ["v1", "en-GB", "I agree to receive reminders."],
    ["v3", "fr-FR", "Envoyez-moi des rappels et des offres."],
    ["v42", "ja-JP", "ショッピング情報を受け取る"],
  ]) {
    const disclosure = { ...grant.disclosure!, version: `moda.woo.whatsapp-recovery-marketing.${version}`,
      locale, text };
    assert.deepEqual(parseWooConsentEvent({ ...grant, disclosure }).disclosure, disclosure);
  }
  for (const version of ["utility", "moda.woo.whatsapp-recovery-marketing.v0",
    "moda.woo.whatsapp-recovery-marketing.v03", "moda.woo.whatsapp-recovery-marketing.v3-extra"]) {
    rejected({ ...grant, disclosure: { ...grant.disclosure, version } });
  }
});
