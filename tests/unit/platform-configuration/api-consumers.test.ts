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

test("Woo return proofs use the current keyring after rotation while retaining old-key verification", async () => {
  const previous = commerceConfig();
  const rotated = loadWooRestReadAuthorizationConfig({
    MODA_WOO_REST_READ_PUBLIC_ORIGIN: "https://api.example.invalid",
    COMMERCE_CONNECTION_ACTIVE_KEY_ID: "new",
    COMMERCE_CONNECTION_KEYS_JSON: JSON.stringify({
      old: Buffer.alloc(32, 3).toString("base64"),
      new: Buffer.alloc(32, 4).toString("base64"),
    }),
  }, "public")!;
  let current = previous;
  let resolutionCount = 0;
  let attemptCount = 0;
  const service = new WooReadAuthorizationService({
    wooCommerceRestReadAttempt: {
      create: async () => ({ id: `attempt-${++attemptCount}`, expiresAt: new Date("2026-10-18T16:00:00Z") }),
      findUnique: async () => ({ shopId: "shop-one",
        installation: { shopId: "shop-one", shop: { storeLocale: "de_DE", defaultLanguageTag: "de-DE" } } }),
    },
  } as never, { publicOrigin: previous.publicOrigin, resolveSecurity: async () => {
    resolutionCount++;
    return { keyring: current.keyring, activeKeyId: current.activeKeyId };
  } }, "public", {} as never, () => new Date("2026-10-18T15:00:00Z"), () => Buffer.alloc(32, attemptCount + 1));
  const principal = { shopId: "shop-one", installationId: "installation-one",
    canonicalSiteUrl: "https://shop.example", credentialVersion: 1 };

  const first = await service.start(principal, "en");
  current = rotated;
  const second = await service.start(principal, "en");
  const proofFrom = (authorizationUrl: string) => {
    const returnUrl = new URL(new URL(authorizationUrl).searchParams.get("return_url")!);
    return returnUrl.searchParams.get("display_proof");
  };
  const oldProof = proofFrom(first.authorizationUrl);
  const newProof = proofFrom(second.authorizationUrl);
  assert.notEqual(oldProof, newProof);
  assert.equal(await service.returnLocale("attempt-1", "en", oldProof), "en");
  assert.equal(await service.returnLocale("attempt-2", "en", newProof), "en");
  assert.equal(resolutionCount, 4);
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

test("R2 configuration revoked after intent prevents finalisation before verification or activation", async () => {
  const principal = { shopId: "shop-one", installationId: "installation-one",
    canonicalSiteUrl: "https://woo.example.test", credentialVersion: 1 };
  const featureConfiguration = { schemaVersion: 1, maxKnowledgeSources: 1, maxContentUnitsPerSource: 1500,
    allowedSourceTypes: [{ purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "CSV" }] };
  const pending = {
    id: "asset-one", shopId: principal.shopId, objectKey: "merchant-knowledge/test/woocommerce/shop-one/asset-one/source.csv",
    status: "PENDING_UPLOAD", uploadExpiresAt: new Date("2026-10-18T19:00:00.000Z"),
    dataFormatId: "format-csv", contentType: "text/csv", sizeBytes: 12n, sha256: "a".repeat(64),
    dataFormat: { key: "CSV", inputKind: "UPLOAD" },
  };
  let queryCount = 0;
  let transactionCount = 0;
  let configurationReads = 0;
  let verificationCount = 0;
  let persistedPending = false;
  const tx = {
    async $queryRaw() {
      queryCount++;
      if (queryCount % 2 === 1) return [{ id: principal.shopId, domain: principal.canonicalSiteUrl,
        platform: "WOOCOMMERCE", shopifyShopId: null, status: "ACTIVE" }];
      return [{ id: principal.installationId, shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
        credentialVersion: principal.credentialVersion, status: "ACTIVE", revokedAt: null }];
    },
    subscription: { async findUnique() { return { status: "ACTIVE", plan: { active: true,
      features: [{ configuration: featureConfiguration }] } }; } },
    merchantKnowledgePurposeDataFormat: { async findFirst() { return { purposeId: "purpose-products",
      dataFormatId: "format-csv", dataFormat: { key: "CSV", active: true, canonicalExtension: ".csv",
        acceptedContentTypes: ["text/csv"] } }; } },
    merchantKnowledgeUploadedAsset: {
      async findUnique() { return persistedPending ? pending : null; },
      async count() { return 0; },
      async create() { persistedPending = true; return pending; },
      async findFirst() { return pending; },
      async update() { throw Error("revoked configuration must prevent asset activation"); },
    },
  };
  const database = { async $transaction<T>(operation: (client: typeof tx) => Promise<T>): Promise<T> {
    transactionCount++;
    return operation(tx);
  } };
  const service = new MerchantKnowledgeUploadService(database as never, {
    environment: "test",
    configuration: { async requireMerchantKnowledgeR2Configuration() {
      configurationReads++;
      if (configurationReads === 1) return { r2Endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
        r2Bucket: "knowledge-bucket", r2AccessKeyId: "access", r2SecretAccessKey: "secret", maxUploadBytes: 1024,
        maxXlsxUncompressedBytes: 2048 };
      throw new Error("configuration revoked");
    } },
    r2: { async sign() { return "https://signed.example.test/object?signature=opaque"; },
      async verify() { verificationCount++; } },
    now: () => new Date("2026-10-18T18:00:00.000Z"),
  });
  const upload = { idempotencyKey: "550e8400-e29b-41d4-a716-446655440000", purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "CSV" as const, originalFileName: "products.csv", contentType: "text/csv", sizeBytes: 12,
    sha256: "a".repeat(64) };

  const intent = await service.intent(principal, upload);
  assert.equal(intent.assetId.length > 0, true);
  assert.equal(persistedPending, true);
  await assert.rejects(() => service.finalize(principal, { assetId: intent.assetId, purposeKey: upload.purposeKey,
    name: "Products", languageTag: "en", contentType: upload.contentType, sizeBytes: upload.sizeBytes,
    sha256: upload.sha256 }), (error: unknown) => error instanceof KnowledgeUploadError &&
      error.status === 503 && error.code === "knowledge_upload_unavailable");
  assert.equal(configurationReads, 2, "intent and finalize each resolve the current sealed configuration");
  assert.equal(verificationCount, 0, "revoked configuration must stop before reading from R2");
  assert.equal(transactionCount, 1, "revoked configuration must stop before finalization's database transaction");
  assert.equal(persistedPending, true, "the existing pending intent is not promoted to an available asset");
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
