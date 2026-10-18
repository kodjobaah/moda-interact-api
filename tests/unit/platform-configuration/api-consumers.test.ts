import assert from "node:assert/strict";
import test from "node:test";
import { createApiPlatformConfigurationReader } from "../../../src/platform-configuration/composition.js";
import { WooReadAuthorizationService } from "../../../src/woocommerce/rest-read/authorization.service.js";
import { loadWooRestReadAuthorizationConfig } from "../../../src/woocommerce/rest-read/config.js";
import { signWooReturnLocale } from "../../../src/woocommerce/rest-read/return-locale-proof.js";
import { MerchantKnowledgeUploadService } from "../../../src/merchant/merchant-knowledge/upload.service.js";
import { KnowledgeUploadError } from "../../../src/merchant/merchant-knowledge/upload-contract.js";
import { loadRuntimeConfig } from "../../../src/runtime-config.js";

const commerceConfig = () => loadWooRestReadAuthorizationConfig({
  MODA_WOO_REST_READ_PUBLIC_ORIGIN: "https://api.example.invalid",
  COMMERCE_CONNECTION_ACTIVE_KEY_ID: "old",
  COMMERCE_CONNECTION_KEYS_JSON: JSON.stringify({ old: Buffer.alloc(32, 3).toString("base64") }),
}, "public")!;

test("Woo return proof takes exactly one fresh key snapshot when a proof is supplied", async () => {
  const staticConfig = commerceConfig();
  let calls = 0;
  const service = new WooReadAuthorizationService({
    wooCommerceRestReadAttempt: { findUnique: async () => ({ shopId: "shop-one",
      installation: { shopId: "shop-one", shop: { storeLocale: "de_DE", defaultLanguageTag: "de-DE" } } }) },
  } as never, { publicOrigin: staticConfig.publicOrigin, resolveSecurity: async () => {
    calls++;
    return { keyring: staticConfig.keyring, activeKeyId: staticConfig.activeKeyId };
  } }, "public", {} as never);
  assert.equal(calls, 0, "composition and construction must not read credentials");
  const proof = signWooReturnLocale(staticConfig, "attempt-one", "shop-one", "en");
  assert.equal(await service.returnLocale("attempt-one", "en", proof), "en");
  assert.equal(calls, 1);
  assert.equal(await service.returnLocale("attempt-one"), "de");
  assert.equal(calls, 1, "plain return never needs a secret lookup");
});

test("Woo protected key-resolution failure is not replaced with an environment keyring", async () => {
  const service = new WooReadAuthorizationService({} as never,
    { publicOrigin: "https://api.example.invalid", resolveSecurity: async () => { throw Error("unavailable"); } },
    "public", {} as never);
  await assert.rejects(() => service.start({ canonicalSiteUrl: "https://shop.example" } as never));
});

test("API composition constructs a lazy root-keyring provider without reading Postgres", async () => {
  let calls = 0;
  const service = createApiPlatformConfigurationReader({
    prisma: { platformConfiguration: { findUnique: async () => { calls++; return null; } } } as never,
    environment: "test", unsealEnvironment: {} as NodeJS.ProcessEnv,
  });
  assert.equal(calls, 0);
  await assert.rejects(service.requireMetaWebhookSecrets(), { code: "MISSING" });
  assert.equal(calls, 1);
});

test("upload intent never loads retired environment credentials when DB configuration is unavailable", async () => {
  const service = new MerchantKnowledgeUploadService({ $transaction: async () => { throw Error("should not access DB"); } } as never, {
    environment: "test", configuration: { requireMerchantKnowledgeR2Configuration: async () => { throw Error("unavailable"); } },
  });
  await assert.rejects(() => service.intent({} as never, {} as never), (err: unknown) => {
    assert.ok(err instanceof KnowledgeUploadError);
    assert.equal(err.status, 503);
    assert.equal(err.code, "knowledge_upload_unavailable");
    return true;
  });
});

test("startup keeps public origin but ignores legacy Commerce environment key material", () => {
  const cfg = loadRuntimeConfig({
    DATABASE_URL: "postgresql://localhost:5432/moda",
    MODA_WOO_REST_READ_PUBLIC_ORIGIN: "https://api.example.invalid",
    COMMERCE_CONNECTION_KEYS_JSON: "not-valid-keyring",
    COMMERCE_CONNECTION_ACTIVE_KEY_ID: "old-invalid",
  });
  assert.equal(cfg.wooRestReadPublicOrigin, "https://api.example.invalid");
  assert.equal(cfg.wooRestReadAuthorization, undefined);
});
