# Hosted API HTTP, billing and authentication characterization baseline

Baseline: `moda-interact-workspace(20261016-004542).zip` (16 October 2026).
This is a **source inventory**, not a claim that pending ARCH-026/035/036/040
work is architect-accepted. Recheck accepted routes against the live mainline
before API-008 and again before API-012. This file does not define new API behavior.

## Server dispatch (current)

`src/server.ts` processes `GET /health/live`, then `GET /health/ready`
before routing other requests through, in order:

1. `woocommerce/rest-read/authorization.routes.ts` (callback, return and grant routes)
2. `woocommerce/billing/webhooks/woo-billing-webhook-route.ts` (provider signature)
3. `woocommerce/installation/routes.ts` (connect, probe, merchant and billing routes)
4. A bounded `404 {"error":"not_found"}` if every router returns `false`.

Current health endpoints return `200 {"status":"ok"}`, `200 {"status":"ready"}`,
or readiness `503 {"status":"not_ready"}` with `Cache-Control: no-store`.
Wrong-method health requests are not short-circuited and normally produce 404.
The new `tests/unit/http/route-dispatch.test.ts` characterizes this sequence.
`tests/unit/http/server.test.ts` additionally covers timeout, lifecycle and database failure.

## Route and contract inventory

All paths below are from inspected handlers or OpenAPI v1 files. Method matters:
`GET` and `POST` purchases intentionally have different owners.

| Method | Path | Current owner | Existing OpenAPI v1 | Existing test anchor |
| --- | --- | --- | --- | --- |
| GET | `/health/live` | `server.ts` | not published in OpenAPI | `tests/unit/http/server.test.ts` |
| GET | `/health/ready` | `server.ts` | not published in OpenAPI | `tests/unit/http/server.test.ts` |
| POST | `/v1/woocommerce/installations/connect` | installation router | `woocommerce-installation-v1.yaml` | `woocommerce/installation/routes.test.ts`, `connection-service.postgres.test.ts` |
| GET | `/v1/woocommerce/installation` | installation router | `woocommerce-installation-v1.yaml` | `tests/unit/auth/woo-installation/authenticator.test.ts`, `routes.test.ts` |
| POST | `/v1/woocommerce/read-authorizations` | REST-read router | `woocommerce-read-authorization-v1.yaml` | `woocommerce/rest-read/authorization.routes.test.ts` |
| GET, DELETE | `/v1/woocommerce/read-authorization` | REST-read router | `woocommerce-read-authorization-v1.yaml` | `woocommerce/rest-read/authorization.routes.test.ts` |
| POST | `/v1/woocommerce/read-authorizations/callback/{opaqueAttemptToken}` | REST-read router | `woocommerce-read-authorization-v1.yaml` | `woocommerce/rest-read/authorization.routes.test.ts`, `authorization.postgres.test.ts` |
| GET | `/v1/woocommerce/read-authorizations/return` | REST-read router | `woocommerce-read-authorization-v1.yaml` | `woocommerce/rest-read/authorization.routes.test.ts`, `return-page.test.ts` |
| POST | `/v1/billing/webhooks/woocommerce` | Woo billing-webhook router | `woocommerce-billing-webhook-v1.yaml` | `woocommerce/billing/webhooks/webhook-route.test.ts`, `webhook-receipt.service.postgres.test.ts` |
| GET | `/v1/merchant/bootstrap` | installation router | `merchant-bootstrap-v1.yaml` | `merchant/bootstrap/openapi-contract.test.ts`, `bootstrap-read.service.postgres.test.ts` |
| PUT | `/v1/merchant/store-context` | installation router | `merchant-store-context-v1.yaml` | `merchant/store-context/routes.test.ts`, `store-context.service.postgres.test.ts` |
| GET | `/v1/merchant/recovery-summary` | recovery-summary router via installation | `merchant-recovery-summary-v1.yaml` | `merchant/recovery-summary/routes.test.ts` |
| GET, PUT | `/v1/merchant/recovery-policy` | recovery-policy router via installation | `woocommerce-merchant-recovery-policy-v1.yaml` | `merchant/recovery-policy/routes.test.ts` |
| GET | `/v1/merchant/recoveries` | recoveries router via installation | `merchant-recoveries-v1.yaml` | `merchant/recoveries/routes.test.ts` |
| GET | `/v1/merchant/recoveries/{recoveryId}` | recovery-detail router via installation | `merchant-recovery-detail-v1.yaml` | `merchant/recoveries/detail/routes.test.ts` |
| GET | `/v1/merchant/recoveries/{recoveryId}/messages` | recovery-detail router via installation | `merchant-recovery-detail-v1.yaml` | `merchant/recoveries/detail/routes.test.ts` |
| GET | `/v1/merchant/recoveries/{recoveryId}/related` | recovery-detail router via installation | `merchant-recovery-detail-v1.yaml` | `merchant/recoveries/detail/routes.test.ts` |
| GET | `/v1/merchant/store-categories` | store-categories router via installation | `merchant-store-categories-v1.yaml` | `merchant/store-categories/routes.test.ts` |
| POST | `/v1/merchant/store-category` | category-selection router via installation | `merchant-store-category-selection-v1.yaml` | `merchant/store-categories/selection-routes.test.ts` |
| GET | `/v1/merchant/discount-catalogue` | discount-offers router via installation | `woocommerce-discount-offers-v1.yaml` | `tests/unit/merchant/discount-offers/routes.test.ts` |
| GET, PUT | `/v1/merchant/discount-offers` | discount-offers router via installation | `woocommerce-discount-offers-v1.yaml` | `tests/unit/merchant/discount-offers/routes.test.ts` |
| GET | `/v1/billing` | installation router | `woocommerce-billing-presentation-v1.yaml` | `tests/unit/billing/presentation/billing-read.service.test.ts`, `tests/integration/billing/presentation/billing-read.postgres.test.ts`, installation `routes.test.ts` |
| GET | `/v1/billing/plans` | installation router | `woocommerce-billing-presentation-v1.yaml` | `tests/unit/billing/presentation/plan-catalogue-read.service.test.ts`, installation `routes.test.ts` |
| GET | `/v1/billing/recovery-credit-purchases` | purchase-history router via installation | `woocommerce-billing-purchase-history-v1.yaml` | `tests/unit/billing/purchase-history/routes.test.ts` |
| POST | `/v1/billing/recovery-credit-purchases` | installation router | `woocommerce-billing-commands-v1.yaml` | installation `routes.test.ts`, `tests/integration/billing/commands/recovery-credit-purchase-command.postgres.test.ts` |
| POST | `/v1/billing/subscription` | installation router | `woocommerce-billing-commands-v1.yaml` | installation `routes.test.ts`, `tests/integration/billing/commands/recurring-subscription-command.postgres.test.ts` |
| DELETE | `/v1/billing/subscription` | installation router | `woocommerce-billing-commands-v1.yaml` | installation `routes.test.ts`, `tests/integration/billing/commands/recurring-subscription-command.postgres.test.ts` |
| POST | `/v1/billing/subscription/switch` | installation router | `woocommerce-billing-commands-v1.yaml` | installation `routes.test.ts`, `tests/integration/billing/commands/recurring-subscription-command.postgres.test.ts` |

Current unhandled method/path falls through to `404`. There is no automatic
`405 Method Not Allowed` negotiation. Do not change this during the refactor.

## Authentication / trust boundary inventory

| Boundary | Proof and authoritative identity | Negative cases / existing tests |
| --- | --- | --- |
| Public health | No caller auth; readiness probes database on GET only | `tests/unit/http/server.test.ts`, `tests/unit/http/route-dispatch.test.ts` |
| Woo connection | Exact bounded JSON connect body with bootstrap secret, verified site-control HMAC challenge and canonical site URL; no pre-existing installation bearer | `woocommerce/installation/routes.test.ts`, `site-verifier.test.ts`, `connection-service.test.ts` |
| Merchant / billing / REST-read grant administration | Exactly one `X-Moda-Installation-Id` and one `Authorization: Bearer <43-character base64url>` in `rawHeaders`; digest lookup against active Woo installation and active Woo shop | `tests/unit/auth/woo-installation/authenticator.test.ts`, `tests/unit/auth/woo-installation/authentication-contract.test.ts` |
| Signed Woo billing webhook | HMAC SHA-256 over raw request body, unique signature header, bounded body and validated topic; not an installation bearer | `woocommerce/billing/webhooks/webhook-route.test.ts`, `webhook-payload.test.ts`, `webhook-receipt.service.postgres.test.ts` |
| Woo REST-read callback | One-time opaque callback token, strict read-only provider payload, persisted attempt/grant checks; not a bearer principal | `woocommerce/rest-read/authorization.routes.test.ts`, `authorization.postgres.test.ts` |
| Browser return | Informational GET only; not evidence of permission, grant or provider state | `woocommerce/rest-read/authorization.routes.test.ts`, `return-page.test.ts` |
| Woo provider outbound | Server-side Woo consumer key/secret for provider REST access, not a browser-provided credential | `woocommerce/rest-read/provider-connection.test.ts`, `provider-transport.test.ts` |

### `WooInstallationAuthenticator` contract for API-014

Originally located at `src/woocommerce/installation/authenticator.ts` in the API-001 baseline;
API-014 relocates the unchanged authenticator to `src/auth/woo-installation/authenticator.ts`:

- Reads **raw**, not normalized, request headers; exactly one of each required header.
- Installation ID is `[A-Za-z0-9_-]{1,128}`; bearer is strictly `Bearer ` plus
  exactly 43 base64url characters encoding 32 bytes via `decodeSecret`.
- Queries `wooCommerceInstallation.findUnique({ where: { id }, select: ... })` for
  `id`, `shopId`, `canonicalSiteUrl`, `credentialVersion`, `credentialDigest`,
  `status`, `revokedAt`, and linked Shop status/platform/shopifyShopId.
- Auth rejects missing/invalid digest, non-`ACTIVE` installation, non-null
  `revokedAt`, non-`ACTIVE` shop, non-`WOOCOMMERCE` platform and any non-null
  `shopifyShopId` with indistinguishable `WooUnauthenticatedError("unauthorized")`.
- Returns only `{ installationId, shopId, canonicalSiteUrl, credentialVersion }`
  from the database row, never client-selected tenant metadata.
- Secret representation: 32 random bytes, canonical 43-character base64url,
  SHA-256 digest, and constant-time digest equality in `src/auth/woo-installation/credential.ts`.
- `src/woocommerce/installation/credential.ts` originally also implemented the
  Woo Connect HMAC site proof. API-014 moves those functions to
  `src/woocommerce/installation/site-proof.ts`, preserving authenticated bytes.
- Existing direct consumers include Woo installation routes, Woo REST-read grant
  routes, merchant recovery summary/policy/list/detail, category routes and
  selection, discount offers, billing purchase history, and service principal
  type imports (bootstrap/store-context/billing read/commands, as applicable).

Rotating the digest between **separate** requests revokes the previous
credential; this baseline makes no assertion about an already in-flight command.

## Billing, size limits and failure-proof anchors

- `MAX_CONNECT_BODY_BYTES=8192`, `MAX_STORE_CONTEXT_BODY_BYTES=2048`,
  `MAX_WOO_BILLING_WEBHOOK_BODY_BYTES=262144`; Woo callback body is limited to
  4096 bytes. Installation, billing command and discount-offer route tests
  validate their existing request parsing and appropriate `400`/`413` handling.
- Billing GET invalid query/body can return `400 {"error":"invalid_request"}`;
  absent/revoked bearer returns `401 {"error":"unauthorized"}`. Schema
  integrity failures are `409` with bounded domain code; unexpected errors
  are `500 {"error":"internal_error"}`.
- Woo billing webhook rejects missing/bad signature, invalid payload and
  unsupported content-type/encoding without echoing raw secrets. Existing
  webhook tests assert the error contracts.
- Billing command replays, idempotency, provider outcomes/failures and durable
  purchasing evidence are covered by:
  `tests/integration/billing/commands/recurring-subscription-command.postgres.test.ts` and
  `tests/integration/billing/commands/recovery-credit-purchase-command.postgres.test.ts`.
  Billing read consistency is covered by
  `tests/integration/billing/presentation/billing-read.postgres.test.ts`.
  Run all three through `scripts/test-arch041-billing-postgres.mjs`, which uses
  `prisma migrate deploy`, not `prisma db push`.

## Validation handoff

Run at the API repository root:

```sh
node --import tsx --test tests/unit/http/route-dispatch.test.ts tests/unit/auth/woo-installation/authentication-contract.test.ts
npm run typecheck
npm run lint
npm test
npm run build
node scripts/test-arch041-billing-postgres.mjs
```

To add a future billing PostgreSQL case, give a file path within
`tests/integration/billing/` as an argument to the billing runner. Tests in
`tests/integration/` intentionally are not part of `npm test`.

This inventory is not test execution evidence. The implementing agent must
record actual commands, results, non-run checks and prepared worktree evidence
in the task Completion Report before submitting for architect review.
