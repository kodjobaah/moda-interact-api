# ARCH-046-API-001 — Woo checkout WhatsApp marketing-consent HTTP contract

This is an **API-owned** v1 transport contract between the authenticated WooCommerce **PHP server** and the hosted Moda API. It does **not** create a recovery, notify a merchant, call Meta, charge credits, publish a job or cause later consent-based checkout rescans. This consent endpoint is not a customer-facing browser endpoint.

## Request

`POST /v1/woocommerce/whatsapp-consent`, `Content-Type: application/json; charset=utf-8` (up to 8,192 bytes). Authenticate with the **existing** Woo installation headers (`X-Moda-Installation-Id` and `Authorization: Bearer <installation secret>`). Do not include `shopId`, `customerId`, user identifiers, or credentials in JSON. The server derives merchant scope from that installed principal, rechecking installation version, status and shop status inside the write transaction. Guest checkout does **not** weaken this authentication requirement.

The JSON contract is `woo.whatsapp-consent.v1`. The API-owned OpenAPI 3.1 contract is `docs/openapi/arch046-woo-consent-v1.yaml`; executable JSON fixtures are `tests/contracts/woocommerce/consent-grant.v1.json` and `consent-revoke.v1.json`. Required keys are exactly:

- `schemaVersion`: `woo.whatsapp-consent.v1`; `purpose`: `WHATSAPP_CHECKOUT_RECOVERY` (abandoned-checkout **marketing**, never utility/transactional permission).
- `eventId`: stable, opaque identifier generated once for the **server-observed customer choice**, preserved unchanged across timeouts/retries; it must not be regenerated merely because the API response was lost. Changing the payload under that ID yields `409 consent_event_replay_conflict`. A later choice needs its own identifier.
- `decision`: `GRANT` on explicitly checked, `REVOKE` on explicitly unchecked; the checkbox MUST be initially unchecked. Phone capture, checkbox render or a merchant recovery setting is not permission.
- `canonicalPhone`: digits-only E.164. `checkoutAction.serverObservedPhone` is the independently observed Woo checkout billing phone, not client-supplied canonical identity. With an independently verified `verifiedCountryCode` for national numbers, the API uses `@modainteract/moda-interact-shared/identity` to normalise it and checks exact equality with `canonicalPhone`. For an international phone, country can be `null` when no verified country is available. Ambiguity, invalid phones and mismatches return `422 recipient_mismatch`.
- `checkoutAction`: required `checkoutKey`, `checkoutMode` (`CLASSIC`/`BLOCKS`), `source=WOO_CHECKOUT_SERVER_HOOK`, `fieldId=moda/whatsapp-checkout-recovery`, `selection` consistent with decision, booleans `userInitiated=true`, `nonceVerified=true`, `sessionVerified=true`, `serverObservedPhone`, `verifiedCountryCode` (`[A-Z]{2}` or `null`), and canonical UTC millisecond `occurredAt`.
- `disclosure`: required for GRANT and null/optional for REVOKE (the field itself remains required). `version=moda.woo.whatsapp-recovery-marketing.v1`, valid `locale`, verbatim customer-visible text (must clearly say **WhatsApp** and include the merchant's exact canonical site URL), plus `merchantSiteUrl` exactly matching the authenticated installation's canonical URL. Do **not** reuse a generic notifications/privacy consent statement.

**PHP producer security obligation (`ARCH-046-WOOCOMMERCE-002/003`):** derive all checkoutAction assertions *after* the current server request passes WooCommerce's Classic checkout nonce / Blocks Store API nonce or cart token, session/cart linkage, server-observed field transition, authenticated plugin-to-Moda installation credentials and server billing phone; do not forward assertion booleans from untrusted JavaScript. The hosted API cannot independently validate the WordPress nonce, guest session, or whether the checkbox was actually clicked. A deliberately forged/old attestation by the merchant-controlled plugin is outside what this bearer-authenticated hosted boundary can prove. In both modes, preserve stable eventId/checkoutKey and monotonic server-observed `occurredAt` across tabs, retries, login/logout and country/phone changes. A newly changed phone is a distinct recipient and requires its **own** confirmed opt-in; do not copy previous consent to a new number. Do not infer consent from Woo phone/billing data.

## Response and ordering

A successful **committed** insert/update returns `200` with `{schemaVersion,status,decision,consentRevision,decisionSequence}`. `status` is `recorded` or `duplicate`. Revision/sequence are PostgreSQL BIGINT decimal strings. A duplicate returns the original revision and is a pure no-op even if a newer withdrawal/STOP was recorded later. `CustomerPhone` and an immutable `WhatsAppConsentEvidence` row are always written in **one** PostgreSQL transaction, not two HTTP calls. Merchant + exact *active* canonical phone must resolve to **one** row or **none** (a normal Customer/CustomerPhone is created); ambiguous matches fail with 409, and lookup by itself never grants permission.

For a **new** GRANT, the API validates active installation, merchant identity, disclosure, and *current* eligible checkout-recovery plan feature in the same transaction. It rejects an outdated checkout page, even when the checkbox appeared before the feature was disabled. A REVOKE is allowed while the feature is disabled, but not from revoked installation credentials. Later accepted decisions must have a **strictly increasing** verified `occurredAt` for that merchant+phone, including an older GRANT arriving after a newer REVOKE; concurrent decisions serialize per canonical recipient. A replay with a different eventId but older/equal timestamp yields `409 stale_consent_action`. Exact event replay remains idempotent. Server-side time bounds reject future choices and GRANT older than five minutes; **this is a freshness check on the checkout action, not a consent expiry**.

**Checkout ordering:** the Woo plugin must await the successful consent **database-commit acknowledgement** before treating a checkout as eligible for a subsequent ordinary `woo.activity` capture. If its ordinary capture overtakes the consent acknowledgement, that checkout can remain ineligible. No automatic catch-up, rescan, recovery wakeup or compensation exists on the consent endpoint. When hosted Moda is unavailable (`503`/timeout), Woo must not block order placement and must not claim the consent was verified. Retry only the same unacknowledged event, with the same ID and body, while the original action is still valid.

`CUSTOMER_STOP` and merchant suppression are separate no-contact authorities: a later valid checkbox GRANT may advance current `whatsappConsentDecision` and evidence but **MUST NOT** clear `whatsappNoContact`, `whatsappNoContactReason`, its revision or timestamps. STOP stays effective for **all outbound WhatsApp** regardless of consent state. No endpoint in this task clears STOP.

## Checkout activity compatibility

The existing authenticated `POST /v1/woocommerce/activity` / `woo.activity.v1` capture remains accepted unchanged. **Optionally**, a producer can use the minimal `woo.activity.v2` HTTP checkout envelope; `checkout.contact` then carries the raw `phone` **plus** `canonicalPhone` and optional `verifiedCountryCode`, normalised by the same published Shared identity helper. The API projects v2 to the existing **v1 checkout queue event** with `contact.phone=+E.164`, so no Background queue contract changes are introduced. **Neither v1 nor v2 activity creates consent**. Woo producer must preserve the consent ACK ordering separately. No new customer/checkout identity table is created.

## Status codes and safety

- `200`: committed `recorded` or unchanged `duplicate`.
- `400`: malformed/forged shape, false CSRF/session/checkbox attestation, unsupported schema, missing or extra identity fields.
- `401`: missing/invalid/revoked/rotated installation credentials or inactive shop.
- `409`: eventId body conflict, stale action, ambiguous phone or unavailable checkout-recovery feature for GRANT.
- `413`: request payload exceeds 8 KiB.
- `422`: phone normalisation mismatch/invalid recipient.
- `503`: database unavailable (no consent acknowledgement). The caller must not treat this as accepted.

Responses use `Cache-Control: no-store`; logging records only merchant identifier, accepted outcome/decision or bounded error reason, never phone, nonce, disclosure text, secret or checkout payload. Send no queued events for this consent request. System tests and the Woo plugin must independently verify the WordPress guest CSRF/session protections and actual customer-driven selection.
