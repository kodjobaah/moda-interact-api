# ARCH-043-API-002 — Private Meta route activation gate

The API-001 typed `requireMetaWebhookSecrets()` is present, but API-002 intentionally does **not** expose a secret-returning HTTP endpoint in this patch.

The supplied Gateway implementation does not provide a documented, approved and implemented service-principal authentication/verifier contract for this endpoint. Network locality, client-controlled headers, a shared public URL, or an unsigned `x-service-name` are **not** authentication. Adding an endpoint on these assumptions would expose `META_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN`.

Before adding/activating the fixed-purpose Meta route, the Gateway owner and architect must specify:

1. The private ingress path, service-only reachability and applicable trust root (for instance an approved mTLS identity or signed internal-service token with independent signing key).
2. A verifier exposed to the API that authenticates provenance and a *specific approved calling service principal*; purpose must be fixed to `messaging.meta`.
3. Signed proof audience, expiry, nonce/replay protection, and how nonce consumption is durably enforced across horizontally scaled API instances.
4. A testable denial matrix for missing/forged identity, wrong purpose/audience, expiry, replay, browser/merchant callers and unknown keys.
5. The Gateway routing and deployment gate; never register the route publicly or return secrets/log payloads without this verified identity policy.

**Implementation status**: Merchant Knowledge and Woo REST-read integrations are provided; the private Meta network route remains blocked on an architecture-approved identity mechanism. Do not retire Messaging env credentials. No `_index.md` updates or cross-repository changes are included.
