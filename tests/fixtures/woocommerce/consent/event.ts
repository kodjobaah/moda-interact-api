import { WOO_CONSENT_DISCLOSURE, WOO_CONSENT_FIELD, WOO_CONSENT_VERSION,
  type WooConsentEvent } from "../../../../src/woocommerce/consent/contract.js";

/** PHP producer must emit precisely this authenticated server-attestation shape. */
export function consentEvent(overrides: Partial<WooConsentEvent> = {}): WooConsentEvent {
  return {
    schemaVersion: WOO_CONSENT_VERSION,
    eventId: "woo-optin-001",
    decision: "GRANT",
    purpose: "WHATSAPP_CHECKOUT_RECOVERY",
    canonicalPhone: "447400123456",
    checkoutAction: {
      checkoutKey: "woo-cart-001",
      checkoutMode: "CLASSIC",
      source: "WOO_CHECKOUT_SERVER_HOOK",
      fieldId: WOO_CONSENT_FIELD,
      selection: "CHECKED",
      userInitiated: true,
      nonceVerified: true,
      sessionVerified: true,
      serverObservedPhone: "+447400123456",
      verifiedCountryCode: "GB",
      occurredAt: "2026-10-22T12:00:00.000Z",
    },
    disclosure: { version: WOO_CONSENT_DISCLOSURE, locale: "en-GB",
      merchantSiteUrl: "https://woo.example", text: "Allow https://woo.example to send WhatsApp abandoned-basket marketing reminders." },
    ...overrides,
  };
}
