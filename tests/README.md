# API test layout

Keep application implementation under `src/` and organize tests by **test
category first, then owning feature**. No `*.test.ts` files remain in `src/`.

```text
tests/
  unit/
    auth/woo-installation/
    billing/commands/
    billing/presentation/
    billing/purchase-history/
    composition/
    http/                    # Includes server tests
    merchant/bootstrap/
    merchant/discount-offers/
    merchant/recoveries/detail/
    merchant/recovery-policy/
    merchant/recovery-summary/
    merchant/store-categories/
    merchant/store-context/
    woocommerce/billing/webhooks/
    woocommerce/installation/
    woocommerce/rest-read/
    runtime-config.test.ts
  integration/
    billing/commands/
    billing/presentation/
    merchant/bootstrap/
    merchant/discount-offers/
    merchant/recovery-policy/
    merchant/store-categories/
    merchant/store-context/
    woocommerce/billing/webhooks/
    woocommerce/installation/
    woocommerce/rest-read/
  contracts/
  helpers/
```

The existing merchant store-context suite had two different `routes.test.ts`
files, one for the server-level route and one testing the handler directly.
Both are retained: `tests/unit/merchant/store-context/routes-runtime.test.ts`
contains the former server-level suite, while `routes.test.ts` contains the
direct handler suite.

Unit and contract tests run via `npm test`; PostgreSQL suites under
`tests/integration/` are **not** discovered by `npm test`. Use the established
feature-specific disposable database runners instead:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run test:integration
npm run test:arch036-discount-offers:postgres
```

The WooCommerce installation runner preserves its existing `prisma db push`
coverage for installation, bootstrap, store context and categories. The
WooCommerce REST-read runner uses `prisma migrate deploy`. The ARCH-041 billing
runner also uses `prisma migrate deploy`, because billing constraints and
integrity triggers must be installed, and the ARCH-036 discount-offers runner
uses migrations for its own database contract.

All 17 integration test files are registered in the standard `npm run test:integration`
chain. The ARCH-041 billing runner includes the two provider-outcome collision
suites by default. The ARCH-036 discount-offers runner remains independently
available through `npm run test:arch036-discount-offers:postgres` and is also
included in the full integration chain. The remaining recovery-policy and Woo
billing-webhook receipt suites run through
`scripts/test-arch041-cross-domain-postgres.mjs`, which uses a fresh database
with `prisma migrate deploy` rather than a schema-only `db push`.

**Important:** The runners create separate disposable PostgreSQL containers. A
passing unit suite or installation `db push` run is not evidence that the
migration-defined billing integrity triggers work. Do not claim integration
coverage until the complete runner chain succeeds.

Feature-based test filenames describe behaviour rather than a task or attempt.
The implementation and test expectations are unchanged by the relocation.
