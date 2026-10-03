# Moda Interact API

Backend-only Node.js service for bounded HTTP health checks, WooCommerce installation connection and authentication.

## Requirements

- Node.js `24.19.0` and npm `11.17.0`.
- PostgreSQL reachable through `DATABASE_URL` for readiness to report healthy.
- The canonical database schema is provided by the `database/` Git submodule.

## Local Development

Initialize nested repositories and install locked dependencies:

```sh
git submodule update --init --recursive
npm ci
npm run prisma:generate
```

Set `DATABASE_URL` to a PostgreSQL connection string. `PORT` is optional and
defaults to `3000`; the server binds to `0.0.0.0`.

```sh
npm run dev
npm run build
npm run start
npm run typecheck
npm run lint
npm test
```

The service exposes `GET /health/live` independently of PostgreSQL and
`GET /health/ready` with a bounded Prisma connectivity probe. WooCommerce
installation routes are documented in
[`openapi/woocommerce-installation-v1.yaml`](openapi/woocommerce-installation-v1.yaml).
The authenticated `GET /v1/merchant/bootstrap` read model is documented in
[`openapi/merchant-bootstrap-v1.yaml`](openapi/merchant-bootstrap-v1.yaml). It
returns shared Shop onboarding and international context plus bounded active
and pending Commerce category identities. It is read-only, performs no
ShopSettings fallback or profile creation, and is intended for the plugin's
server-side PHP client rather than browser JavaScript.
Startup and shutdown logs use the canonical Shared structured logger; health
responses do not include configuration or database error details.

The HTTP stack is Node.js's built-in `node:http`; the service does not own
database migrations. `MODA_WOOCOMMERCE_CONNECTION_MODE` defaults to `public`.
Set it to `local-development` only for local testing; startup rejects that mode
under `NODE_ENV=production`.

### Local WooCommerce Connection Testing

No public or paid WordPress host is needed. Run a local WordPress/WooCommerce
installation with the Moda connection challenge callback available at
`/wp-json/moda-interact/v1/connection/challenge`. The callback accepts
`attempt_id` and `nonce`, then returns their values and the base64url
HMAC-SHA256 proof defined in the OpenAPI contract. Keep the bootstrap secret in
PHP/server-side state; never expose it to browser JavaScript.

For a local host-name fixture, map `woocommerce-sandbox.local` to `127.0.0.1`
in the developer machine's hosts file and configure the local web server to use
that host. A loopback URL such as `http://127.0.0.1:8080` is also accepted.
Then start the API with a non-production `NODE_ENV`, the accepted database
`DATABASE_URL`, and:

```sh
MODA_WOOCOMMERCE_CONNECTION_MODE=local-development npm run dev
```

Submit the connect request from a server-side PHP client, then use the returned
installation ID and credential only from PHP for
`GET /v1/woocommerce/installation`. The local mode still resolves and pins the
target address, rejects mixed local/public DNS results, validates HTTPS
certificates when HTTPS is used, and does not permit arbitrary public HTTP.

The PostgreSQL transaction and race suite uses a fresh invocation-owned Docker
container and drops it after completion:

```sh
npm run test:integration
```
