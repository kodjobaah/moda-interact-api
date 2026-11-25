# WooCommerce recovery template provisioning

## Contract and trigger

The WooCommerce API consumes the same platform defaults as Shopify: `WhatsAppRecoveryTemplateDefault(wabaId, purpose, format)`. No platform-specific defaults or new schema are introduced. Deploy only against a database pin including `20261125010000_whatsapp_recovery_default_formats` and compatible Admin/Shopify/Background consumers. The six checkout purposes each require TEXT (including no header) and may have IMAGE. A complete configuration yields 240 assignments per merchant. Missing optional IMAGE is not an incident. TEXT must not require ShopBrand variables or media.

After the authenticated site-control connect/reconnect transaction commits Free activation and the installation, invoke provisioning with its non-secret identity. Recheck the exact current credential version, site, active shop/installation and onboarding state inside each assignment transaction. Do not execute on failed connection or change billing, consent, credentials or the wire response. Use the canonical transaction-scoped platform sender reader. The implementation ports the existing Shopify frozen-evidence/format/assignment rules into API modules; package extraction is a separate refactoring, not claimed by this patch.

## Assignment and concurrency

Process TEXT purposes first, then IMAGE. Each slot is independently atomic: serialize using the common-layout activation lock and the existing shop/WABA/purpose publication lock; lock the source definition, locale and registration evidence; verify 20 exact supported locales, immutable compiled content and reconciled Meta approval, active common layout references and the current configured sender. Create the shop-specific COMPLETE publication operation, 20 variants and 20 SUCCEEDED targets with the platform-default provenance. Preserve existing independently complete slots, even if the platform default changes; incomplete, ambiguous, invalid or historical same-format assignments require Admin review rather than overwrite/reactivation. No external Meta call or media fetch is performed.

## Failure and retry

Provisioning is best-effort post-commit work within an eight-second start budget, reduced against elapsed connection time (25 seconds target, plugin request timeout 30 seconds). Bounded transaction acquisition/execution and incident writes consume the same budget. This is not an absolute HTTP latency guarantee; the original connection has its own timeout/retry policy. Missing mandatory defaults, invalid evidence, partial assignments and transaction errors produce structured operational diagnostics and a deduplicated internal incident when time permits. Budget exhaustion logs the unfinished slot and does not change the successful connection result. A subsequent authenticated reconnect retries missing slots; Admin can publish directly to existing shops. No durable retry job is added. Operators should verify all required TEXT slots after deployment; a successful connect alone is not a readiness guarantee.

## Validation and remaining work

Run the focused node:test suites, existing installation PostgreSQL runner, typecheck and full API unit suite. The PostgreSQL test seeds canonical source evidence; it does not contact Meta. This patch is based on the archived API snapshot from 18 November 2026; check applicability against the actual current checkout and dependency pin. The existing WooCommerce human follow-up API/plugin contract limits its catalogue to 30 choices and prefers IMAGE where present; exposing both formats independently requires a coordinated API/plugin change. Shared Background runtime fallback and cross-platform end-to-end tests remain separate rollout gates. Do not infer delivery readiness from assignment counts alone.
