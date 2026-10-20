# ARCH-035-API-017: Woo Merchant Knowledge file lifecycle

> **ARCH-035-API-018 browser transport amendment:** This API-017 document
> replaces API-017's original PHP-server PUT transport with a privileged
> **metadata-only** PHP broker plus a browser Blob `PUT` directly to R2; see [`arch035-browser-direct-knowledge-upload.md`](arch035-browser-direct-knowledge-upload.md).
> API-017 lifecycle code and its accepted task history are unchanged.

The WooCommerce PHP plugin uses the authenticated Moda merchant endpoints, not direct PostgreSQL or R2 credentials. `POST /v1/merchant/merchant-knowledge/upload-intents` returns a short-lived (at most ten-minute) R2 PUT URL for a single immutable CSV/XLSX object. PHP brokers only its metadata to an authenticated, authorised administrator's browser with `Cache-Control: no-store`; neither PHP nor the browser persists it or renders it in HTML. All hosted upload endpoints require the existing installation ID and bearer credential, which are never exposed to browser code. Request and response details are in `openapi/merchant-knowledge-v1.yaml`.

## Upload sequence

1. The browser computes the exact file size and lowercase SHA-256 of the selected local `File`/`Blob`, chooses an entitled source-pair from the catalogue, and submits *only metadata* to privileged WordPress PHP. PHP brokers an intent with a stable client-generated UUID `idempotencyKey`. Retrying the same intent after a network timeout uses the same UUID and *identical metadata*.
2. PHP checks the signed PUT URL: `https`, no userinfo, the expected configured R2 account origin, no private/IP/loopback destination or unexpected port. Fail closed when the URL cannot be proven to match the approved origin. Return it only in the authorised administrator's no-store metadata response. The browser independently refuses redirects, uses bounded timeouts/abort and never forwards the PHP installation bearer or other Moda credentials to R2.
3. The **browser** PUTs the Blob bytes directly to R2 with exactly the returned `Content-Type`, `If-None-Match: *` and `x-amz-meta-sha256` header values, `credentials: "omit"` and `redirect: "error"`. WordPress receives **no** file bytes. Do not follow 3xx redirects. The R2 object must be immutable during the intent lifetime.
4. After a successful PUT only, privileged PHP brokers `POST /v1/merchant/merchant-knowledge/upload-finalize` with `assetId`, `purposeKey`, `name`, `languageTag`, `sizeBytes`, `sha256`, `contentType`, and optional *owned* `sourceId` for replacement. The API checks HEAD metadata and streams GET bytes to recompute SHA-256 and size before transactional source/revision changes. A repeated finalize returns the same revision, not a duplicate. R2 unavailability fails closed.
5. The persisted revision is initially `PENDING`; the existing Background reconciliation handles ingestion when entitlement and merchant activation permit it. Returning an accepted revision is **not** a claim that it was queued or ingested. Metadata updates and reprocess use the authenticated source endpoints.

For **new** WooCommerce upload intents, Moda generates the R2 key server-side:
`merchant-knowledge/<deployment-env>/woocommerce/<verified-shop-id>/<canonical-shop-hostname>/<UTC-timestamp>-<asset-id>.csv|xlsx`.
For example: `merchant-knowledge/development/woocommerce/shop_123/store.example.com/20261019T180524350Z-550e8400-e29b-41d4-a716-446655440000.csv`.
The hostname is derived from the Shop row after validating the active installation and
canonical URL; browser-provided filenames and URLs cannot choose the storage path.
Shop ID remains the immutable tenant boundary; a changed domain only affects new
intents. Timestamp and identity are generated **once** for an intent and its
persisted `MerchantKnowledgeUploadedAsset.objectKey` is reused unchanged on retry,
including intents written before this key layout was introduced.

Previously uploaded objects retain their exact legacy R2 keys. No objects are
moved and no database migration is required. Finalise and Background continue
to read the persisted `objectKey`; Shopify's existing keys are unchanged.

## Deployment configuration (API service only)

Production composition resolves the **sealed** `PlatformConfiguration` key
`merchant.knowledge.r2` through the API's purpose-scoped on-demand reader.
It supplies `endpoint`, `bucket`, `accessKeyId`, `secretAccessKey`,
`maxUploadBytes` and `maxXlsxUncompressedBytes`. Endpoint must be a Cloudflare
account S3 API endpoint (`https://<32 hexadecimal digits>.r2.cloudflarestorage.com`),
with no custom port or URL credentials; the upload maximum is bounded to
25 MiB. The older `MERCHANT_KNOWLEDGE_R2_*` parser is retained for isolated
API-017 fixture compatibility and is **not** called by production composition.
Secrets are never returned from the hosted merchant API other than the opaque,
short-lived signed URL. Key registration and runtime secret wiring belong to
the platform configuration/Gateway owner. Missing/unsealable R2 configuration
fails only the upload operation closed with a bounded 503.

Gateway owns the required approved-origin R2 CORS policy for browser-direct
uploads; see [API-018 browser handoff](arch035-browser-direct-knowledge-upload.md).

Validate with `npm run test:arch035-knowledge-upload:postgres` (disposable Docker PostgreSQL with deployed migrations), `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and `git diff --check`. Integration fixtures include actual CSV and XLSX bodies; the unit suite checks request bounds, signer metadata/host and byte integrity.
