# ARCH-046-API-006: Proof-backed WooCommerce consent status

Endpoint: `POST /v1/woocommerce/whatsapp-consent/status`.

This is a read-only endpoint for the server-held proof created after API-007
acknowledges a Woo v2 `GRANT`. It accepts the canonical Woo status-v1 request:

```json
{"schemaVersion":"woo.whatsapp-consent-status.v1","canonicalPhone":"447400123456","grantEventId":"woo-consent-example-01"}
```

It returns HTTP 200 with exactly `{ "schemaVersion": "woo.whatsapp-consent-status.v1", "state": "CONFIRMED_GRANTED" }`
(or `state: "UNVERIFIED"`), and `Cache-Control: no-store`. No reason,
recipient, customer identifier, evidence identifier, or other operational detail appears
in the successful response. Unauthorized installations receive 401, invalid
bodies 400/413, and unexpected database/SDK errors 503. Original provider error
name, code, message, stack/cause and safe status metadata are retained in
redacted server-side `@modainteract/moda-interact-shared/logging` events.

## Query plan and consistency

* Authentication uses the existing `WooInstallationAuthenticator` (the current
  installation credential lookup, including shop status/platform).
* **Exactly one** additional parameterised `SELECT` is made against the existing
  `(shopId,eventId)` unique evidence index. The query joins `CustomerPhone`,
  `Customer`, the active Woo installation, and the active shop to confirm the
  evidence, purpose, phone, installation and current revision/sequence. It
  excludes retired phones, stale evidence and revoked checkbox consent.
* **No explicit Prisma transaction**, no isolation-level override, no locks, no
  other database reads, no feature/subscription queries, no DB writes, no Redis
  and no outbound HTTP/provider calls. PostgreSQL's single-statement snapshot
  is sufficient for current-state verification; a REVOKE already committed
  when the statement begins cannot yield a confirmed grant.
* Authenticator lookups may be implemented by Prisma as multiple SQL statements
  depending on the ORM relation-loading strategy. The endpoint itself adds
  exactly one joined SELECT; use the disposable PostgreSQL test's query log to
  measure the total observed SQL count rather than assuming two statements
  without measurement.
* This snapshot result is not an authorization to send a future message; the
  downstream messaging checks remain independent of this checkbox-only read.

## Validation

```sh
npm run test:arch046-woo-consent-status:unit
npm run test:arch046-woo-consent:postgres
MODA_WOO_SOURCE_ROOT=/path/to/moda-interact-woocommerce npm run test:arch046-woo-consent-status:php
npm run typecheck
npm run lint
npm run build
```

The disposable `test:arch046-woo-consent:postgres` runner includes the status
read scenarios. It requires the migration-current pg17/pgvector test database;
never point it at a merchant/production database. HTTP integration exercises
`createWooRoutes` and `composeApiRoutes`, using real installation bearer auth
and real API-007 GRANT/REVOKE writes. Integration scenarios cover stale proof,
wrong tenant/phone, retired recipient and credential
rotation. The test records actual SQL statement counts, measured Prisma SQL
execution times and seven warm real-HTTP samples (p50/p95), separately from
the static one-joined-query design. Timing is empirical evidence on a local
container, not a production latency guarantee or an arbitrary pass threshold.

The PHP contract test loads `includes/Api/ModaApiClient.php` and its real
supporting classes from `MODA_WOO_SOURCE_ROOT` (the separate WooCommerce task
checkout). It sends the exact response bytes from an in-process API-006 HTTP
route through `wooConsentStatus()`, checking both states, the public error and
strict rejection of extra response fields. The caller's WooCommerce repository
is not copied or changed inside the API repository. PHP must be available on
`PATH`; missing source or PHP fails the dedicated test rather than silently
skipping the contract.

The PostgreSQL acceptance fixture also verifies independent same-phone merchants,
several parallel reads after a committed REVOKE, invalid request scoping,
authentication before evidence reads, and unchanged evidence, CustomerPhone
and recovery rows across repeated status reads. The request SQL log is audited
for writes and explicit transactions; no queues or provider calls are made by
the status service.

This status read is *not* a preflight for an explicit same-checkout withdrawal.
The Woo r07 same-checkout withdrawal path remains independent of this endpoint.
