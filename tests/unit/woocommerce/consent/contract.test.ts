import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseWooConsentEvent, WooConsentHttpError } from "../../../../src/woocommerce/consent/contract.js";
import { consentEvent } from "../../../fixtures/woocommerce/consent/event.js";

const rejected = (value: unknown) => assert.throws(() => parseWooConsentEvent(value),
  (error: unknown) => error instanceof WooConsentHttpError && error.status === 400);

test("strict canonical Woo consent GRANT and explicit REVOKE are distinct", () => {
  const grant = consentEvent();
  assert.deepEqual(parseWooConsentEvent(grant), grant);
  const revoke = consentEvent({ eventId: "woo-uncheck-002", decision: "REVOKE", disclosure: null,
    checkoutAction: { ...grant.checkoutAction, selection: "UNCHECKED" } });
  assert.deepEqual(parseWooConsentEvent(revoke), revoke);
});

test("rejects forged browser identity, default checkbox, unverified Classic and Blocks sessions", () => {
  const source = consentEvent();
  for (const broken of [
    { ...source, shopId: "victim" }, { ...source, customerId: "victim" },
    { ...source, checkoutAction: { ...source.checkoutAction, customerId: "victim" } },
    { ...source, checkoutAction: { ...source.checkoutAction, source: "BROWSER" } },
    { ...source, checkoutAction: { ...source.checkoutAction, nonceVerified: false } },
    { ...source, checkoutAction: { ...source.checkoutAction, sessionVerified: false } },
    { ...source, checkoutAction: { ...source.checkoutAction, userInitiated: false } },
    { ...source, checkoutAction: { ...source.checkoutAction, selection: "UNCHECKED" } },
    { ...source, checkoutAction: { ...source.checkoutAction, checkoutMode: "OTHER" } },
    { ...source, checkoutAction: { ...source.checkoutAction, fieldId: "woocommerce.phone" } },
    { ...source, checkoutAction: { ...source.checkoutAction, occurredAt: "2026-02-30T12:00:00.000Z" } },
    { ...source, checkoutAction: { ...source.checkoutAction, verifiedCountryCode: "gb" } },
    { ...source, schemaVersion: "woo.whatsapp-consent.v2" },
    { ...source, canonicalPhone: "+447400123456" },
    { ...source, disclosure: null },
    { ...source, disclosure: { ...source.disclosure, version: "utility" } },
    { ...source, disclosure: { ...source.disclosure, text: `${source.disclosure!.text}\u0001` } },
    { ...source, disclosure: { ...source.disclosure, text: `${source.disclosure!.text}\u007f` } },
  ]) rejected(broken);
  const blocks = consentEvent({ checkoutAction: { ...source.checkoutAction, checkoutMode: "BLOCKS" } });
  assert.equal(parseWooConsentEvent(blocks).checkoutAction.checkoutMode, "BLOCKS");
});

test("versioned disclosures preserve localized customer copy without text-content matching", () => {
  const source = consentEvent();
  const examples = [
    { version: "moda.woo.whatsapp-recovery-marketing.v1", locale: "en-GB",
      text: "Allow https://woo.example to send WhatsApp abandoned-basket marketing reminders." },
    { version: "moda.woo.whatsapp-recovery-marketing.v2", locale: "de-DE",
      text: "Ich stimme zu, Marketingnachrichten über WhatsApp zu erhalten." },
    { version: "moda.woo.whatsapp-recovery-marketing.v3", locale: "fr-FR",
      text: "Envoyez-moi des actualités, des rappels et des offres." },
    { version: "moda.woo.whatsapp-recovery-marketing.v42", locale: "ja-JP",
      text: "お買い物に関するお知らせを受け取ります。" },
  ];
  for (const example of examples) {
    const grant = { ...source, disclosure: { ...source.disclosure!, ...example } };
    const parsed = parseWooConsentEvent(grant);
    assert.deepEqual(parsed, grant);
    assert.equal(parsed.disclosure?.text, example.text);
    assert.equal(parsed.disclosure?.version, example.version);
    assert.equal(parsed.disclosure?.merchantSiteUrl, "https://woo.example");
  }
  for (const version of ["utility", "moda.woo.whatsapp-recovery-marketing.v0",
    "moda.woo.whatsapp-recovery-marketing.v03", "moda.woo.whatsapp-recovery-marketing.v3-extra"]) {
    rejected({ ...source, disclosure: { ...source.disclosure, version } });
  }
  rejected({ ...source, disclosure: { ...source.disclosure, text: "" } });
  rejected({ ...source, disclosure: { ...source.disclosure, merchantSiteUrl: "" } });
});

test("a checkbox render/phone lookup is never consent evidence", () => {
  const source = consentEvent();
  rejected({ ...source, checkoutAction: { ...source.checkoutAction, userInitiated: undefined } });
  rejected({ ...source, decision: "REVOKE", checkoutAction: source.checkoutAction });
  rejected({ ...source, decision: "GRANT", checkoutAction: {
    ...source.checkoutAction, selection: "CHECKED", nonceVerified: "true" } });
});


test("API-owned transport examples stay executable and match the PHP/hosted boundary", () => {
  for (const [name, mode] of [["grant", "GRANT"], ["revoke", "REVOKE"]] as const) {
    const fixture = JSON.parse(readFileSync(`tests/contracts/woocommerce/consent-${name}.v1.json`, "utf8")) as unknown;
    assert.deepEqual(parseWooConsentEvent(fixture), fixture);
    assert.equal(parseWooConsentEvent(fixture).decision, mode);
  }
});
