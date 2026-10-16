# API test layout

Keep implementation files in `src/` and organize new tests by **test type** and
**feature**, not by task ID or implementation attempt.

```text
tests/
  unit/merchant/discount-offers/
    contract.test.ts
    routes.test.ts
    offer-settings.test.ts
  integration/merchant/discount-offers/
    catalogue-and-selection.test.ts
    concurrent-updates.test.ts
    offer-settings-and-catalogue.test.ts
  integration/billing/presentation/
    billing-read.postgres.test.ts
```

The repository still contains older co-located `src/**/*.test.ts` tests.
`npm test` runs both those tests and `tests/unit/**/*.test.ts` while they
are migrated in separate, bounded refactors. Integration tests are intentionally
**not** included in `npm test` and require the disposable PostgreSQL runner:

```bash
npm test
npm run test:arch036-discount-offers:postgres
npm run typecheck
npm run build
```

Feature-based filenames should describe test behavior (e.g. `offer-settings`,
`concurrent-updates`) rather than naming an architecture task or attempt.
PostgreSQL tests use the integration path and are run explicitly by their
feature-specific disposable database harnesses. For billing presentation, run
`node scripts/test-arch041-billing-postgres.mjs` (with `prisma migrate deploy`);
for discount offers, run `npm run test:arch036-discount-offers:postgres`.
The WooCommerce installation PostgreSQL runner also discovers the moved billing
presentation suite via its updated file path. Production source and
`tsconfig.build.json` are unchanged.
