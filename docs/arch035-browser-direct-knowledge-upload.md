# ARCH-035-API-018: Browser-direct Woo Merchant Knowledge R2 PUT contract

**API-017 remains the owner of the existing upload intent, immutable R2 object,
finalisation, revision and idempotency lifecycle.** API-018 certifies that the
same version-1 intent can be used by a WooCommerce administrator's browser.
It does not create a second signer, database model or hosted upload endpoint.
The complete versioned HTTP schema is `openapi/merchant-knowledge-v1.yaml`.

## Authority and boundaries

1. **Browser -> WordPress:** an authenticated WooCommerce administrator with
   `manage_woocommerce` and a valid WordPress REST nonce sends only upload
   **metadata** to the privileged WordPress controller. PHP validates the
   session, connected installation and current site identity. No CSV/XLSX
   request body or temporary WordPress file is accepted by the broker.
2. **WordPress -> Moda API:** PHP alone supplies `X-Moda-Installation-Id`
   and its installation bearer to `POST /v1/merchant/merchant-knowledge/upload-intents`.
   The API authenticates, locks the active Woo Shop and current credential
   version, checks entitlement, writes an immutable pending asset and returns:

   ```json
   {
     "schemaVersion": 1,
     "assetId": "<opaque-owned-asset-id>",
     "uploadUrl": "<opaque-signed-https-r2-s3-put-url>",
     "expiresAt": "<ISO-8601-UTC-time>",
     "maxUploadBytes": 1048576,
     "requiredHeaders": {
       "Content-Type": "text/csv",
       "If-None-Match": "*",
       "x-amz-meta-sha256": "<lowercase-64-hex-character-file-SHA-256>"
     }
   }
   ```

   The size in this example is illustrative, **not** a platform default.
   `Content-Type` is the exact validated MIME declared at intent; supported
   types come from the entitled catalogue. Header values must not be rebuilt
   by WooCommerce. A signed URL is an **object-scoped bearer capability**;
   its SigV4 query may reveal the access-key identifier, but never the R2
   **secret access key**. A URL is not permission to list/read other objects.
3. **WordPress -> browser:** return only these bounded intent fields to the
   authorised administrator over HTTPS with `Cache-Control: no-store`. Neither
   WordPress nor Moda logs, stores, reflects into errors/HTML, or adds the URL
   to analytics/telemetry, page navigation or persisted browser state. WordPress
   never receives installation credentials in browser JavaScript. Reject signed
   URLs except `https://<32-hex-account>.r2.cloudflarestorage.com/` on the
   **configured, approved exact account origin**; no userinfo, custom port,
   custom host, fragments or redirect. Validate a short expiry and the three
   exact approved required-header names/values before returning the capability.
4. **Browser -> R2:** from the local selected `File`/`Blob`, compute size and
   SHA-256 first (client checks are advisory; API will independently verify).
   Send `PUT` **directly to the unmodified** `uploadUrl` with the complete
   `requiredHeaders` map and the original Blob bytes, e.g. conceptually:

   ```javascript
   const response = await fetch(uploadUrl, {
     method: "PUT",
     body: file, // File/Blob; do not serialize it or wrap in FormData
     headers: requiredHeaders,
     credentials: "omit",
     redirect: "error",
     mode: "cors",
     cache: "no-store",
     signal: abortController.signal,
   });
   if (!response.ok) throw new Error("upload_failed");
   ```

   `If-None-Match: *` prevents overwriting an existing key. No WordPress
   cookies, WordPress nonce, Moda bearer, extra authentication or R2 access
   keys are sent as headers. **Never follow a redirect** or retry an already
   successful PUT against the immutable key. Browser request-header casing is
   case-insensitive on the wire, but signed values and bytes must be exact.
   A successful request normally has an R2 2xx response; client success is
   not proof that content was intact. The API signer configures the SDK to
   calculate checksums only when required: it must not accidentally sign an
   SDK-generated CRC32 for the **empty presigning request** as if it described
   the later browser Blob. The API's authoritative SHA-256 verification remains.
5. **Browser -> WordPress -> Moda API:** after a confirmed PUT only, the browser
   sends the metadata `assetId`, `purposeKey`, `name`, `languageTag`,
   `contentType`, `sizeBytes`, `sha256`, optional owned replacement `sourceId`
   to the privileged WordPress finalise broker. WordPress rechecks session,
   nonce, connected site identity and installation state. The authenticated
   API reads the object via R2 `HEAD` then bounded `GET`, checks metadata,
   length and recomputed SHA-256 **before** committing `AVAILABLE` asset and
   durable `PENDING` revision. Repeat finalise is idempotent. A successful
   finalise means `ACCEPTED`, not that Background ingestion has completed.

## Time, replay and error semantics

| Condition | Expected client behaviour | Server result / durable state |
|---|---|---|
| PUT 2xx | Broker finalise with exact metadata | HEAD + streamed hash verification is mandatory; accept only verified bytes |
| Existing object, R2 412 | Do not overwrite; check if prior PUT succeeded, then finalise only with the **same** immutable intent/bytes | Existing valid bytes may finalise; wrong bytes are rejected |
| Wrong/missing signed header, modified URL or signature | Stop; do not finalise | R2 SigV4 rejection; the API never authorises an alternative object |
| Expired signature or durable `expiresAt` | Stop; request a fresh intent with a new upload UUID if expired | Reusing an expired intent/finalise returns `409 knowledge_upload_expired` |
| Redirect or unsafe host | Treat as failed; do not forward URL/body/credentials | No finalise; no redirect-following |
| CORS/preflight failure | Stop; show safe retry guidance after policy correction | The browser never establishes a valid PUT; this is **not** an API authentication failure |
| Network failure or user cancellation | Do not assume completion; retry only when safe within the remaining intent time | No new source created merely by issuing an intent |
| API finalise `409` | Show integrity/conflict/expiry; never mark uploaded | No new available revision without verification |
| API/WordPress `401`, `403`, `404`, `413`, `503` | Show bounded error, avoid URL/payload in notifications | Auth/entitlement/quota/network errors fail closed; unrelated reads are still available |

Retry the **same** idempotency UUID only with byte-identical metadata. An
in-flight or uncertain PUT may have reached R2: `412` does not automatically
mean failure or success. Attempt finalisation only after the client has
reconciled confirmed object upload with matching identity, and rely on API
verification. A newly expired upload requires a **new** idempotency UUID.
All handled upload-intent/finalise HTTP responses, successful or erroneous,
are `Cache-Control: no-store` and bounded JSON; no signed URL is returned on
failure. Logs use the shared Node logging runtime and only bounded
`shopId`/operation/safe error code (no URL/query, object key, file bytes,
SHA-256, WordPress nonce or installation secret).

## Browser preflight and deployment dependency (GATEWAY-001)

The R2 bucket must have an explicitly provisioned **per-approved-Woo-origin**
CORS policy, including allowed method `PUT`, allowed request headers
`content-type`, `if-none-match`, `x-amz-meta-sha256` and suitable OPTIONS
preflight handling. Allowed origins are enrollment-controlled **exact origins**,
not `*`, arbitrary `Origin`, tenant-supplied response headers or public
shop domains inferred from untrusted text. The client should not rely on
reading `ETag`; success status is enough to attempt authenticated finalise.
R2 CORS is a browser transport policy, **not** tenant authorisation.

`POST` intent and finalise remain hosted API operations through WordPress; they
are **not** cross-origin browser API endpoints. R2 presigning still uses the
Cloudflare account **S3 API hostname**, not the public `r2.dev` URL or a
merchant website. The deployment environment and R2 keyring are resolved
server-side on demand from sealed `PlatformConfiguration` key
`merchant.knowledge.r2` through the existing API configuration reader;
missing/disabled/unsealable configuration fails the **upload operation** closed,
not unrelated merchant reads. The key contains endpoint, bucket, access key
ID, secret access key, max upload bytes and maximum uncompressed XLSX bytes.
Never put secrets or signed URLs into Render blueprints or repositories.

Rollout order: accept/deploy API-018 contract -> provision and verify
GATEWAY-001 exact-origin R2 CORS in the target environment -> enable
WOOCOMMERCE-014 privileged metadata broker -> enable WOOCOMMERCE-015 browser
uploader -> developer manually validate -> run terminal system tests.
The fixture `tests/unit/merchant/merchant-knowledge/upload-browser-transport.test.ts`
exercises ordinary Blob PUT over local HTTP, signature/header/expiry/replay and
simulated OPTIONS requirements; it does **not** establish a real Cloudflare R2
CORS/browser-network pass. Live verification belongs to Gateway and system
certification. No changes to Shopify storage identities, existing Background
revision reconciliation or existing WooCommerce routes are required here.
