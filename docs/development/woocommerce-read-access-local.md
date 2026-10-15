# WooCommerce REST read access — LocalWP/ngrok runbook

**Scope:** Local development only. This runbook covers the native WooCommerce `scope=read` consent flow for `moda-interact-woocommerce` and `moda-interact-api`. It does **not** cover production deployment or merchant billing.

## Remember this before testing

> **Start ngrok and keep it running.** WooCommerce must POST its generated read-only consumer credentials to the Moda API through a reachable **public HTTPS** callback. Starting the API on `localhost:3100` alone is not enough.

The ngrok forwarding URL must **exactly match** `MODA_WOO_REST_READ_PUBLIC_ORIGIN` in the API's runtime configuration. If ngrok assigns a different URL, update that environment variable, restart the API, and generate a **new** consent link.

## Startup checklist

- [ ] Start the `woocommerce-sandbox.local` site in LocalWP and log in as a WooCommerce administrator.
- [ ] Ensure the local PostgreSQL database is running and the Moda installation is connected.
- [ ] Ensure the API's credential keyring is loaded securely (`COMMERCE_CONNECTION_KEYS_JSON` and `COMMERCE_CONNECTION_ACTIVE_KEY_ID`). **Do not regenerate it on every restart** if you need to read existing encrypted grants.
- [ ] Start `moda-interact-api` on **port 3100**.
- [ ] Start **ngrok forwarding to port 3100** in a separate terminal; leave it open during approval.
- [ ] Confirm the public ngrok URL matches `MODA_WOO_REST_READ_PUBLIC_ORIGIN` and passes the health check below.
- [ ] Only then start a **fresh** WooCommerce read-access approval attempt.

### Terminal 1 — Moda API

From the root of `moda-interact-workspace`:

```bash
cd moda-interact-api

# Supply the existing secure credential-keyring environment before launching.
# start-dev.sh sets local-development mode and the public callback origin.
bash start-dev.sh
```

The snapshot's `moda-interact-api/start-dev.sh` exports:

```bash
export MODA_WOOCOMMERCE_CONNECTION_MODE=local-development
export MODA_WOO_REST_READ_PUBLIC_ORIGIN="https://85ba-2a0a-ef40-8d3-fa01-4c9b-4d10-fbd6-b9f0.ngrok-free.app"
```

**Important:** `start-dev.sh` starts the API; it **does not start ngrok** or generate encryption keys. Look for `api.started` with `port: 3100` in the API logs.

### Terminal 2 — ngrok (leave running)

```bash
ngrok http 3100 \
  --url="https://85ba-2a0a-ef40-8d3-fa01-4c9b-4d10-fbd6-b9f0.ngrok-free.app"
```

This assumes that the specified ngrok domain is available in your ngrok account. If it is not, start a tunnel using an available domain, set `MODA_WOO_REST_READ_PUBLIC_ORIGIN` to that **exact HTTPS origin** in the API environment, restart the API, and create a new attempt. Do not use a stale approval URL generated with an old origin.

### Terminal 3 — verify both sides of the tunnel

```bash
# Local API (expected HTTP 200, JSON {"status":"ok"})
curl -i http://127.0.0.1:3100/health/live

# Public HTTPS route to the SAME API (expected HTTP 200 and the same JSON)
curl -i \
  https://85ba-2a0a-ef40-8d3-fa01-4c9b-4d10-fbd6-b9f0.ngrok-free.app/health/live
```

The public response should be the API's JSON health response, **not** an ngrok error page. If it fails, check the ngrok terminal and the origin/port before doing anything in WordPress.

## Approve read-only access

1. In WordPress Admin, open **WooCommerce → Moda Interact**. Confirm **Connection: Connected**.
2. Under **Store read access**, click **Allow read access**.
3. Click **Open WooCommerce approval** (the current interface opens it in another tab; it does not automatically navigate there).
4. On WooCommerce's native `/wc-auth/v1/authorize` page, approve the **read-only** request.
5. WooCommerce makes a server-to-server POST to the public Moda API callback. Its browser return page is informational, **not** evidence that the grant succeeded.
6. Return to Moda Interact and click **Check access**. Expected result: **Connected — Read access approved**.

Expected API log sequence:

```text
woocommerce.rest_read.authorization.started
woocommerce.rest_read.authorization.approved  {"outcome":"committed"}
```

The API callback route is:

```text
POST /v1/woocommerce/read-authorizations/callback/{opaqueAttemptToken}
```

The browser return route is:

```text
GET /v1/woocommerce/read-authorizations/return
```

**Never copy or publish the full callback URL or Woo consumer key/secret.** The callback path contains a bearer token; network traces/inspectors may also contain sensitive payloads.

## Verify the database (optional)

In `psql`, use this read-only query; it does not expose encrypted credentials or keys:

```sql
SELECT
    i."canonicalSiteUrl",
    i."status" AS "installationStatus",
    g."status" AS "readGrantStatus",
    g."authorizedScope",
    g."verifiedAt"
FROM woocommerce."WooCommerceInstallation" AS i
LEFT JOIN woocommerce."WooCommerceRestReadGrant" AS g
    ON g."installationId" = i."id"
WHERE i."canonicalSiteUrl" = 'http://woocommerce-sandbox.local';
```

After a successful approval, expect installation status `ACTIVE`, read grant status `ACTIVE`, and authorised scope `read`. A `NULL` grant means approval has not produced a committed read-access grant.

## Troubleshooting

| Symptom | First checks | Action |
| --- | --- | --- |
| WooCommerce `/wc-auth/v1/access_granted/` says it could not send consumer data | ngrok running? public `/health/live` returns Moda JSON? callback reached API? | Start/fix ngrok, match the API public origin, then initiate fresh consent. If callback reaches the API but fails, inspect its bounded failure reason instead of assuming a tunnel problem. |
| API logs `authorization.started` but never `authorization.approved` | ngrok request inspector at `http://localhost:4040` and API logs | Determine whether WooCommerce's callback reached the API. Be careful: inspector entries may contain secrets. |
| **Awaiting WooCommerce approval**, but no **Open WooCommerce approval** link | Browser-to-plugin authorisation response, especially `REMOTE_RESPONSE_INVALID` | Check that the installed WooCommerce plugin contains the **v2 proof response-validator fix** and that a fresh POST to `/connection/read-access/authorize` returns HTTP 201 with a usable consent URL. |
| Consent returns, but read access still shows **Pending** | API callback logs, fresh status read, attempted grant | Do not trust the `success=1` browser parameter; click **Check access** and investigate callback errors. |
| After changing ngrok domains, approval still goes to the old host | `MODA_WOO_REST_READ_PUBLIC_ORIGIN` at API startup and old browser tab | Restart the API with the new origin and begin a fresh attempt. |
| Installation says **Reconnect**, especially after manual database changes | Local WordPress installation credential versus API installation row | Avoid manually deleting `commerce."Shop"` or rotating credentials. Restore/reconnect through the supported flow; investigate data inconsistency separately. |

If ngrok shows that the callback arrived but the API rejected it, check structured `woocommerce.rest_read.authorization.failed` log entries and the local-store credential verification. `woocommerce-sandbox.local` is an HTTP/local-development WooCommerce site; retain the existing local-development safeguards. **Do not disable callback validation, TLS requirements for public origins, credential verification, or SSRF protections to make the test pass.**

## Shutdown and next session

Stop the API and ngrok when finished. Next time, **start both again before requesting approval**. If the read grant is already `ACTIVE` and the persisted encryption keyring is unchanged, normal status reads do not require repeating WooCommerce approval. ngrok is needed again when a new public callback/reauthorisation is required.

**Related source:** `moda-interact-api/src/woocommerce/rest-read/README.md` and `docs/architecture/ARCH-026-woocommerce-application-foundation.md`.
