# ARCH-046-API-005: merchant-owned WhatsApp recovery selection

The hosted API deliberately separates the customer's existing WhatsApp checkout
consent from the merchant's recovery selection. All requests are made by the
WordPress PHP admin proxy; **never** send the installation bearer to JavaScript.

## Endpoints

- `GET /v1/woocommerce/customer-recovery-selection?canonicalPhone=447400123477`
- `POST /v1/woocommerce/customer-recovery-selection`

Both require the existing `Authorization: Bearer <installation credential>` and
`X-Moda-Installation-Id`, plus `X-Moda-WP-Admin-Verified: 1`. The **server-side
WooCommerce plugin** must emit the last header only after verifying the active
WordPress login, an appropriate merchant management capability (for example
`manage_woocommerce`), and the current privileged WP REST nonce. It must not
relay any browser-supplied header. Hosted API checks the installation bearer,
shop, installation lifecycle and credential version again inside the transaction.
The API has no access to WordPress sessions; **the assertion is not independent
proof of WordPress nonce/session validity**. WP verification belongs to
`ARCH-046-WOOCOMMERCE-007`.

The query contains **exactly one** digits-only canonical E.164 phone without `+`;
the API also validates it with the published Shared phone normalizer;
there is no shopId or customerId selector. Query and response are `Cache-Control:
no-store`. The read result is bounded and contains neither a phone nor a
customer identity:

```json
{
  "schemaVersion": "woo.customer-recovery-selection.v1",
  "consentDecision": "GRANTED",
  "suppressed": false,
  "suppressionReason": null,
  "noContactRevision": "0",
  "phoneEligibleForRecovery": true,
  "canReenable": false
}
```

`phoneEligibleForRecovery` means only current Woo checkout-consent plus local
contact eligibility; billing, active settings, recovery, templates and delivery
are separately gated and **not guaranteed** by this flag.

The command requires `Content-Type: application/json` (2 KiB limit):

```json
{
  "schemaVersion": "woo.customer-recovery-selection.v1",
  "canonicalPhone": "447400123477",
  "action": "SUPPRESS",
  "expectedNoContactRevision": "0",
  "evidenceReference": null
}
```

`action` is `SUPPRESS`, `REENABLE`, or `RECORD_CUSTOMER_STOP`. A STOP requires
an opaque, bounded `evidenceReference` (such as an externally managed support
ticket identifier); other commands require `null`. No arbitrary customer contact
message, PII or text is accepted. The external evidence is held by the calling
merchant system; the approved CustomerPhone schema persists the authoritative
no-contact reason, revision and time **but not this external reference**. The
API neither logs nor stores its value. If centrally persisted audit provenance
is required, the architect must assign a separate storage contract rather
than misusing the immutable checkbox `WhatsAppConsentEvidence` table.

Replies contain the read status plus `outcome: "updated" | "duplicate"`.
Expected revisions are decimal strings for PostgreSQL BIGINT. With the current
revision, a matching no-op does not increment it. The immediately preceding
identical state transition may be retried with its previous revision; a stale
request after any later transition fails with HTTP 409. A client should read
again after a conflict and require a fresh administrator decision instead of
silently retrying with a newer revision.

- `SUPPRESS`: sets `MERCHANT_OPT_OUT`, including on an unconsented known phone;
  it **never** grants consent.
- `REENABLE`: can clear *only* `MERCHANT_OPT_OUT` and requires an already
  `GRANTED` `WOO_MODA_CHECKBOX` consent decision on the same current phone.
- `RECORD_CUSTOMER_STOP`: sets terminal `CUSTOMER_STOP`, even if consent is
  unknown or merchant suppression already exists. No merchant call clears it.

An active, single exact canonical recipient in the installation's merchant is
required. Ambiguity returns 409; missing or changed numbers return 404. This
command performs **no checkout search/reconciliation, scheduling, billing, or
recovery creation**. A future normal recovery path must consult the latest
CustomerPhone permission and no-contact state at admission and send time.

Error responses use bounded machine codes (`unauthorized`,
`admin_authorization_required`, `invalid_request`, `request_too_large`,
`customer_phone_not_found`, `ambiguous_customer_phone`,
`stale_no_contact_revision`, `customer_consent_required`,
`customer_stop_authoritative`, `selection_unavailable`). No raw database
errors, customer phone, credential, evidence reference or PII is logged.

## Validation

`npm run test:arch046-woo-selection:unit` checks HTTP attestation, strict
request contract and no-store behaviour. `npm run
test:arch046-woo-selection:postgres` reuses the disposable ARCH-046 consent
PostgreSQL runner and adds installation-authenticated merchant suppression
integration, replay, STOP precedence, consent changes, changed-number,
ambiguous/cross-shop reads and concurrent no-contact decisions. Tests require
an API database submodule containing accepted ARCH-045-DATABASE-002 migrations;
`prisma db push` is not an alternative.
