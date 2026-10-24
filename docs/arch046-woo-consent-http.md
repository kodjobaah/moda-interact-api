# ARCH-046 — Woo WhatsApp checkout consent: API v2 (breaking pre-production contract)

**Rollout:** Pre-production breaking change. Moda has no existing production users or consent records to migrate. The former `woo.whatsapp-consent.v1` **is not accepted**. The WooCommerce plugin must adopt the six-field v2 payload before end-to-end checkout consent is enabled. This is a producer implementation task owned by `moda_woocommerce`, not an API change.

## Endpoint and security boundary

`POST /v1/woocommerce/whatsapp-consent` (the HTTP path remains stable),
`Content-Type: application/json` (optional UTF-8 charset), body max 8,192 bytes.
Require the active WooCommerce installation credential in the `Authorization: Bearer` header and `X-Moda-Installation-Id`. Authenticate **before** reading a bounded JSON body. Only the WooCommerce **PHP server** may call this endpoint; it is not a browser endpoint.

The WooCommerce plugin owns checkout verification: session/cart, Classic nonce or Blocks Store API nonce/cart token, deliberate checked opt-in/explicit withdrawal, server-observed billing phone and displayed shop-localized disclosure. The API cannot verify WordPress session state and does not accept attacker-controlled `nonceVerified`, `checkoutMode`, `selection` or analogous assertions.

The API independently authenticates the installation, rechecks Shop and installation status/credential version in the consent transaction, validates a single canonical recipient, records immutable consent evidence and ensures ordering/idempotency. Merchant ID and the fixed `WHATSAPP_CHECKOUT_RECOVERY` purpose derive from the authenticated route; no `shopId`, `customerId`, checkout key, merchant URL or purpose field is accepted in the body.

## Six-field v2 payload

```json
{
  "schemaVersion": "woo.whatsapp-consent.v2",
  "eventId": "stable-event-id",
  "decision": "GRANT",
  "canonicalPhone": "447400123456",
  "occurredAt": "2026-10-24T10:00:00.000Z",
  "disclosure": {
    "version": "moda.woo.whatsapp-recovery-marketing.v3",
    "locale": "en-GB",
    "text": "Send me WhatsApp shopping updates, reminders and offers."
  }
}
```

Top-level fields are **exactly** `schemaVersion`, `eventId`, `decision`, `canonicalPhone`, `occurredAt`, `disclosure`. For `REVOKE`, `disclosure` must be **null** and no checkbox/unchecked flag is needed. GRANT requires exactly `version`, `locale`, `text` in `disclosure`, containing the exact wording shown to the customer. Disclosure revisions `moda.woo.whatsapp-recovery-marketing.vN` are independent of transport v2 and translations need not contain a merchant URL/name or particular English phrase.

`canonicalPhone` is digits-only E.164, normalised/validated once by the published Shared identity helper. `occurredAt` is the actual server-observed consent action time in canonical UTC milliseconds, not API receipt time. `eventId` is stable across retries and scoped to the authenticated shop. The API never creates consent merely because a shopper enters a phone number.

See the canonical OpenAPI 3.1 specification at `docs/openapi/arch046-woo-consent-v2.yaml` and executable golden contracts at `tests/contracts/woocommerce/consent-{grant,revoke}.v2.json`.

## Short synchronous commit

1. Authenticate installation credentials using the existing authenticator.
2. Parse bounded JSON and reject unsupported versions/fields.
3. In a short PostgreSQL transaction, revalidate installation and shop via **one locked JOIN**; serialise by event ID and canonical recipient; check immutable evidence for duplicate/replay conflicts.
4. Preserve safe observed-time ordering. Reject future timestamps and GRANT older than five minutes (these are server clock-freshness constraints, **not** consent expiration). Do not remove these until a reviewed replacement ordering protocol exists.
5. Locate/create the shop-scoped `Customer` and `CustomerPhone`, update current consent without modifying `whatsappNoContact`/`CUSTOMER_STOP`, append one immutable `WhatsAppConsentEvidence`, commit and acknowledge. Duplicate event returns its original revision and sequence.

No billing/plan/feature query, recovery creation, checkout scan, Redis/BullMQ event, Meta call or outbound message occurs in this API operation. Background must check current entitlement, consent and STOP before any subsequent recovery or outbound message. Database uniqueness, advisory locks, revision ordering and STOP precedence remain enforced.

Only a committed transaction returns `200` (`recorded` or `duplicate`) with `schemaVersion`, `status`, `decision`, decimal-string `consentRevision` and `decisionSequence`. Failure codes: `400` malformed/unsupported/extra fields, `401` unauthenticated or revoked installation, `409` replay/stale/ambiguous phone, `413` oversized body, `422` invalid recipient, `503` database unavailable. Responses use `Cache-Control: no-store`, logs exclude customer phone, full disclosure, credential or checkout payload.

## Producer rollout and consent ordering

The existing WooCommerce checkout producer sends v1 today; it must be modified to send v2 **before** this endpoint is used in checkout. No production backward-compatibility adapters or dual-parser are required. Coordinate API and Woo deployment in the pre-production environment and run the integrated system tests before marking ARCH-046 implemented.

The Woo plugin must await successful consent commit before treating ordinary `woo.activity` as eligible for consent-gated recovery. A failed/timeout consent write must not block order placement or be treated as accepted. Retry only the original unacknowledged event with an unchanged event ID/body while valid. The separate `/v1/woocommerce/activity` endpoint and its queue contract remain unchanged; activity does not create consent.

The consent event ID is for idempotency, **not** proof of returning-customer identity. ARCH-046-API-006 must require a separately established secure account/session binding before revealing consent status. STOP messages remain authoritative regardless of any subsequent GRANT.

## ARCH-046-API-007 Attempt 2: failure injection and measured comparison

`npm run test:arch046-woo-consent:postgres` runs the normal disposable PostgreSQL
consent tests, including an actual database-trigger failure between the
`CustomerPhone` mutation and immutable evidence insertion. The test asserts
both the existing permission and a newly created customer's state roll back.
It also exercises API-006's full `(shopId, eventId, canonicalPhone,
customerPhoneId, phoneConsentRevision)` evidence lookup, including negative
shop/revision probes. The trigger is dropped even when the test fails; it is
never deployed by a migration.

For a comparable **before/after** measurement, run from the dedicated API-007
implementation worktree with its normal Git history and Docker environment:

```sh
ARCH046_CONSENT_COMPARE_BASELINE=1 npm run test:arch046-woo-consent:postgres \
  2>&1 | tee arch046-api007-attempt2-validation.log
```

The disposable test runner first executes its normal integration tests, then
archives the pinned pre-change Git tree (`220fa2b^`, overridable by
`ARCH046_CONSENT_BASELINE_REF`) into an isolated temporary directory. It runs
the **same** `performance.postgres.test.ts` fixture against the archived v1
service and the current v2 service; the archived directory is deleted on exit.
The legacy v1 producer fields exist only inside the benchmark fixture, not in
the running v2 API. The comparison is unavailable if the pinned historical Git
revision, installed dependencies or Docker PostgreSQL are unavailable; report
that limitation rather than marking performance evidence complete.

Each `ARCH046_CONSENT_COMPARISON` JSON line records `version`, `scenario`
(`fresh_GRANT`, `existing_GRANT`, `REVOKE`, `duplicate_retry`, and
`stale_GRANT_failure`, and `injected_evidence_failure`), `sql_statements`, `transaction_client_ms`,
`scenario_wall_ms`, `outcome`, and whether a billing query ran.
`transaction_client_ms` measures the client-observed duration of the Prisma
`$transaction` call (including its SQL and callback, excluding HTTP
installation authentication and test setup). It is **not** database-server-only
time or an exact network-free SQL duration. `scenario_wall_ms` includes the
rest of the scenario. These isolated measurements are not a throughput capacity
benchmark or production p95, and runtimes may vary with caching and host load.
Include the paired emitted values and any failure outcomes in the Completion
Report before checking the task's performance criterion.
