import { WOO_CONSENT_DISCLOSURE, WOO_CONSENT_VERSION,
  type WooConsentEvent } from "../../../../src/woocommerce/consent/contract.js";

/** A server-authenticated Woo consent assertion with no checkout-attestation fields. */
export function consentEvent(overrides: Partial<WooConsentEvent> = {}): WooConsentEvent {
  return {
    schemaVersion: WOO_CONSENT_VERSION,
    eventId: "woo-optin-001",
    decision: "GRANT",
    canonicalPhone: "447400123456",
    occurredAt: "2026-10-22T12:00:00.000Z",
    disclosure: { version: WOO_CONSENT_DISCLOSURE, locale: "en-GB",
      text: "Send me WhatsApp shopping updates, reminders and offers." },
    ...overrides,
  };
}
