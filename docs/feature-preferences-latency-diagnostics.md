# Feature-preferences API latency diagnostics (WooCommerce)

Scope: authenticated `GET` and `PUT /v1/merchant/feature-preferences`. These
fields are emitted by `@modainteract/moda-interact-shared/logging` in the API's
normal JSON logs. No new endpoint, header, consent decision, or timeout is added.

## Reproduce

Use the existing WooCommerce development checkout to trigger the feature
eligibility lookup. Search the **API** logs for:

```text
merchant.feature_preferences.timing
```

Every request emits a single timing record. A successful request also emits
`merchant.feature_preferences.access`; a failing authenticated service request
emits `merchant.feature_preferences.access.failed`. Match related records by
`diagnosticId`. The request and feature row data are **not** logged. Retain the
original error details from `access.failed` when diagnosing failures; the
`failedPhase` is an additional locator, not a replacement for the provider error.

## Interpret the fields (milliseconds, monotonic clock)

| Field | What it measures |
| --- | --- |
| `durationMs` | Total route execution inside Node up to the end of the timing log setup, not full remote HTTP round-trip |
| `authenticationMs` | Header/credential validation, DB installation lookup, constant-time digest verification |
| `authenticationLookupMs` | Prisma installation `findUnique`, including its own acquisition/DB time |
| `authenticationOtherMs` | Remaining authentication time (not a separately sampled operation) |
| `requestValidationMs`, `requestBodyMs` | HTTP request constraints and PUT JSON body read/parse |
| `serviceMs` | Entire service call, including Prisma transaction completion |
| `transactionMs` | Entire Prisma interactive transaction lifecycle |
| `transactionEntryMs` | From starting the transaction to callback entry: connection/pool wait plus transaction setup; NOT pool wait alone |
| `transactionWorkMs` | Time inside the interactive transaction callback |
| `transactionFinishMs` | Approximate remainder after callback, including commit/rollback and Prisma completion |
| `shopLookupMs`, `installationLookupMs` | The two identity checks performed inside the transaction |
| `shopValidationMs`, `installationValidationMs` | Validations of those identity results |
| `subscriptionLookupMs` | Subscription with plan and plan-feature join |
| `subscriptionEligibilityMs` | Plan/subscription eligibility guard |
| `featuresLookupMs`, `preferencesLookupMs` | Feature and merchant-preference database reads (issued via `Promise.all`) |
| `capabilitySelectionMs`, `projectionMs`, `responseValidationMs` | Shared capability selection, revision/DTO projection, service DTO validation |
| `routeResponseValidationMs`, `responseDispatchMs` | Route DTO validation and synchronous `response.end()` call; **not** client receipt |
| `featureUpsertsMs` | PUT only: updates inside the existing transaction |
| `failedPhase` | First failing timed phase, when applicable |
| `statusCode`, `outcome`, `connectionClosed` | Route-level result and whether the socket was already destroyed |

Important: these timers are **nested and some database reads overlap**. Do not
add all phase times together or equate `transactionEntryMs` with pure PostgreSQL
connection wait. Prisma transaction internals and network transfer time after
`response.end()` are not independently measured here.

## Investigate a slow request

1. If `authenticationMs` is large, compare `authenticationLookupMs` with
   `authenticationOtherMs` to separate the installation query from verification.
2. If `transactionEntryMs` is large, investigate connection availability,
   transaction-start cost and PostgreSQL/network latency.
3. If `transactionWorkMs` is large, identify which query/selection field is high;
   compare `subscriptionLookupMs` with the individual feature lookups.
4. If `transactionFinishMs` is large, inspect transaction commit/rollback and
   database connectivity.
5. If the API's `durationMs` is small but WordPress reports a 2-second cURL
   timeout, investigate network routing, proxy, TLS, or WordPress-side timeout
   and queueing. API-local timing cannot account for the complete client path.

This endpoint's read path does not directly use Redis. Redis `ETIMEDOUT` or
`ECONNRESET` from other API components must be investigated separately; the
presence of those errors does not by itself prove they caused this endpoint's
latency.

The patch intentionally does **not** increase WordPress's 2-second eligibility
HTTP timeout or change consent/STOP safeguards. First compare measured phases
with the client-side deadline, then decide whether an API optimisation or a
coordinated timeout change is required.
