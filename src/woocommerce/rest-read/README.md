# WooCommerce REST read authorization (ARCH-026-API-007)

The existing WooCommerce installation credential authenticates plugin -> Moda API calls. This module separately handles merchant-approved **Moda API -> WooCommerce** grants. It never requests WooCommerce write access.

## Runtime configuration

The feature is disabled when all three new variables are absent; supplying only some causes startup to fail closed.

- `MODA_WOO_REST_READ_PUBLIC_ORIGIN`: the fixed public HTTPS origin of `moda-interact-api`, e.g. `https://api.example.com`; no path, query, credentials or fragment. In explicit nonproduction `MODA_WOOCOMMERCE_CONNECTION_MODE=local-development`, an HTTP `localhost`/loopback origin is permitted for locally routed callbacks.
- `MODA_WOO_REST_READ_ACTIVE_KEY_ID`: active encryption key ID, e.g. `2026-10-a`. Never reuse the value of an installation credential.
- `MODA_WOO_REST_READ_KEYRING`: a JSON object mapping key IDs to **32-byte base64url-encoded AES-256 keys**. Keep previous key IDs in the keyring while any encrypted grants still reference them. Use a secure secrets manager; do not commit values or log them.

Example for a **disposable local test** only:

```sh
export PORT=3100
export MODA_WOO_REST_READ_PUBLIC_ORIGIN='http://localhost:3100'
export MODA_WOO_REST_READ_ACTIVE_KEY_ID='local-v1'
export MODA_WOO_REST_READ_KEYRING="$(node -e 'process.stdout.write(JSON.stringify({"local-v1":require("node:crypto").randomBytes(32).toString("base64url")}))')"
export MODA_WOOCOMMERCE_CONNECTION_MODE=local-development
```

Do not enable production until the public callback route has confirmed HTTPS reachability from the merchant's WooCommerce server, gateway access logs **redact the `/read-authorizations/callback/*` path**, and database migrations/client generation are deployed.

## API lifecycle

- `POST /v1/woocommerce/read-authorizations`: authenticated installation principal; bodyless. The WordPress Admin facade optionally sends `X-Moda-Admin-Locale` from `get_user_locale()` **after its capability and nonce checks**. Issues a short-lived Woo `scope=read` consent URL. The returned URL embeds a callback bearer; never log it. A supported administrator presentation locale is carried only in a signed, attempt-bound return URL; no schema migration or stored shop-language mutation is needed.
- `GET /v1/woocommerce/read-authorization`: authenticated; reflects committed status only (`CONNECTED`, `PENDING`, `NOT_CONNECTED`, `REAUTHORIZATION_REQUIRED`). Never returns keys.
- `DELETE /v1/woocommerce/read-authorization`: authenticated; invalidates pending attempts and marks the existing grant revoked, preventing new reads from using it. The merchant must separately delete the WooCommerce key from **WooCommerce > Settings > Advanced > REST API**.
- `POST /v1/woocommerce/read-authorizations/callback/{opaqueAttemptToken}`: WooCommerce JSON server callback, capped at 4096 bytes. Checks exact attempt and `read` scope; performs a DNS-pinned, TLS-verified, no-redirect GET of one product ID against the **same** canonical site; then atomically consumes the attempt and writes an AES-256-GCM grant in PostgreSQL.
- `GET /v1/woocommerce/read-authorizations/return`: informational browser page only. The `user_id` identifies the persisted authorisation attempt. An administrator locale from the authenticated start is accepted only when its attempt-and-shop-bound HMAC proof verifies against a server-held key from the configured keyring; otherwise the page uses its shop's `Shop.storeLocale`, then `defaultLanguageTag`, then English. The shared 20-language resolver is used for both preferences. Both completion and cancellation text are localised, with `Content-Language` set to the selected language. The page is a self-contained, script-free branded HTML document with a hashed CSS policy. The `success` and `user_id` URL parameters are never proof of consent or a committed grant, and no credentials or shop identifiers are rendered. Missing/invalid attempts or lookup failures fall back to English without changing grant state. The WordPress administrator's locale is presentation-only; neither the persisted shop locale nor customer conversation language is changed. Old approval links without a signed locale continue to work using the shop locale.

The credential verifier never sends write requests. For local development it permits only the same local/private endpoint restrictions as the original site verifier; all public endpoints still require HTTPS. LocalWP without a reachable, approved callback cannot complete the real provider smoke test; do not bypass SSRF protections to make a test pass.

## Dependencies and validation

`ARCH-026-DATABASE-003` must be committed/migrated before use, and the `moda-interact-api/database` submodule must resolve to that accepted Prisma schema. Run `npm run prisma:generate` after synchronizing the submodule; do not copy schema models into API source.

```sh
npm run typecheck
npm run lint
npm test
npm run test:integration
```

The integration suite starts its own disposable PostgreSQL Docker container and tests same-shop grant lifecycle, replay, stale generations, rotation and local revocation; no production data is touched. A real consent/callback/return smoke requires a non-production WooCommerce site reachable from the API and an API callback reachable from WooCommerce.

**Not implemented here:** WordPress consent UI (`ARCH-026-WOOCOMMERCE-015`), general authenticated outgoing read connector (`ARCH-026-API-008`), or MCP/Commerce tool execution. The status response is not proof that stored WooCommerce credentials remain valid forever; API-008 will need to handle later provider-side revocation.

## In-process product connection (ARCH-026-API-008)

`createWooProductReadPort({ database, authorization, mode, logger })` returns an
**API-process-only** port with `read(authorizedShopId, operation)`.
The `authorizedShopId` MUST come from an already-authenticated, shop-authorized
server principal. **Do not** accept a raw shop ID from a request body, expose the
port over a generic HTTP endpoint, or return its credentials to another service.

Only two WooCommerce `wc/v3` operations are implemented initially:

- `products.list` — `page` (1..100), `perPage` (1..20) and a bounded `search` string.
- `products.retrieve` — a positive numeric `productId`.

Both use `GET`, `context=view` and a fixed `_fields` projection, with an
allowlisted return object containing only `id`, `name`, `sku`, `price`,
`stockStatus`, and `stockQuantity`. The product-list response is limited to 20
items and 128 KiB; product detail to 32 KiB; total provider timeout is 5 seconds.
No customer/order data, writes, arbitrary origins, custom HTTP headers or
provider redirects are allowed. A `401`/`403` against an operation does not
invalidate the grant on its own; a separate read credential verification must
confirm access loss. INVALID updates compare the existing grant identity and
rotation version so stale requests cannot invalidate a newer grant.

The connection uses DATABASE-003's selected Woo read grant and API-007's
AES-256-GCM keyring, TLS peer checks, DNS-pinned HTTP transport and local-only
allowance. The inbound Woo plugin credential is never used for provider reads.
A revocation or rotation detected after HTTP completion prevents returning the
provider data. Provider failures produce bounded reason codes without source
URLs, HTTP Authorization headers, response bodies or secrets.

To validate:

```sh
npm run typecheck
npm run lint
npm test
npm run test:integration
```

`test:integration` also runs the provider-read PostgreSQL fixture using the
actual DATABASE-003 migration and a loopback Woo-compatible product endpoint.
This does **not** replace the non-production real WooCommerce read-through proof,
which requires a merchant-approved `scope=read` grant and a publicly reachable,
TLS-valid store. No Commerce/MCP/Background network contract is implemented here;
that requires a separate authorised adapter decision.

## LocalWP HTTP REST API authentication

When an explicitly configured `local-development` store is HTTP on an approved
local/private address, WooCommerce `wc/v3` uses **OAuth 1.0a** rather than Basic
authentication. API-007 credential verification and API-008 product reads share
`WooReadCredentialVerifier`, which now signs each fixed GET using HMAC-SHA256,
a fresh 32-character nonce, timestamp and all original query parameters. The
consumer **secret** never goes in an HTTP header or URL; the OAuth query does
contain the **consumer key**, nonce and signature. Do not log request URLs with
those values, even in development. Redirects and unsafe DNS addresses remain
rejected. No generic OAuth port or arbitrary endpoint access is introduced.

For real/public stores, continue to require HTTPS and Basic authentication.
Do not enable HTTP authentication for public addresses or send the Consumer
Secret as a URL query parameter. The HTTPS Moda callback origin is a separate
requirement from the WooCommerce store's HTTP/HTTPS authentication scheme.

Validation: `npm run typecheck && npm run lint && npm test && npm run test:integration`,
followed by a new LocalWP merchant consent attempt and a real authenticated
product-read smoke test. A failed Woo native consent response can cause its
newly generated key to be revoked; never reuse credentials from a failed attempt.

The return-page signing key is derived separately from the configured credential-encryption key, **not from the callback bearer embedded in the consent URL**. Keep previous keyring entries configured while earlier authorisation attempts can still return through WooCommerce. Unknown/invalid/tampered presentation proof values are ignored rather than applied; older plugin versions send no locale and continue using the persisted shop language. No language preference is written to the Shop record or to WooCommerce's grant tables.
