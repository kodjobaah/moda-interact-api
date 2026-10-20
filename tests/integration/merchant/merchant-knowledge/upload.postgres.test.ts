import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { encryptCredential, parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import { MerchantKnowledgeUploadService } from "../../../../src/merchant/merchant-knowledge/upload.service.js";
import { deterministicAssetId, KnowledgeUploadError, parseFinalize, parseIntent } from "../../../../src/merchant/merchant-knowledge/upload-contract.js";
import type { UploadR2 } from "../../../../src/merchant/merchant-knowledge/upload-r2.js";
import { apiPlatformConfigurationAad } from "../../../../src/platform-configuration/contracts.js";
import { createApiPlatformConfigurationReader } from "../../../../src/platform-configuration/composition.js";
import { adminR2PlaintextFixture } from "../../../fixtures/platform-configuration/r2-admin-payload.js";

const connection = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const config = { schemaVersion: 1, maxKnowledgeSources: 2, maxContentUnitsPerSource: 1500,
  allowedSourceTypes: [{ purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "CSV" },
    { purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "XLSX" }] };
const bytes = Buffer.from("sku,description\n1,Example product\n");
const checksum = createHash("sha256").update(bytes).digest("hex");
const xlsxBytes = readFileSync(new URL("./fixtures/sample-knowledge.xlsx", import.meta.url));
const xlsxChecksum = createHash("sha256").update(xlsxBytes).digest("hex");
const xlsxContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test("migration-backed Woo upload: unique tenant asset, retries, replacement, reprocess, merchant-off and expiry",
  { skip: !connection }, async () => {
    if (!connection) return;
    const db = new PrismaClient({ datasources: { db: { url: connection } } });
    const marker = randomUUID();
    const domain = `https://${marker}.upload.example.invalid`;
    const shop = await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE", defaultLanguageTag: "en" } });
    const foreign = await db.shop.create({ data: { domain: `${domain}-other`, platform: "WOOCOMMERCE", status: "ACTIVE" } });
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32), credentialVersion: 3,
    } });
    const alien = await db.wooCommerceInstallation.create({ data: {
      shopId: foreign.id, canonicalSiteUrl: `${domain}-other`, credentialDigest: Buffer.alloc(32),
    } });
    const principal = { shopId: shop.id, installationId: installation.id, canonicalSiteUrl: domain, credentialVersion: 3 };
    const foreignPrincipal = { shopId: foreign.id, installationId: alien.id,
      canonicalSiteUrl: `${domain}-other`, credentialVersion: 1 };
    const feature = await db.feature.upsert({ where: { key: "merchant_knowledge" },
      create: { key: "merchant_knowledge", displayName: "Merchant Knowledge", active: true,
        activationMode: "MERCHANT_OPT_IN" }, update: { active: true, activationMode: "MERCHANT_OPT_IN" } });
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `test-upload-${marker}`, name: "Woo upload test", kind: "PAID_METERED", active: true,
    } });
    await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id, enabled: true, configuration: config } });
    await db.subscription.create({ data: { shopId: shop.id, planId: plan.id, status: "ACTIVE" } });
    const wrappingKeyJson = JSON.stringify({ wrapping: randomBytes(32).toString("base64") });
    const wrappingKeyring = parseCredentialKeyring(wrappingKeyJson);
    const sealR2Configuration = (version: number, maxUploadBytes: number) => {
      const envelope = encryptCredential({ keyring: wrappingKeyring, activeKeyId: "wrapping",
        plaintext: JSON.stringify({ ...adminR2PlaintextFixture, maxUploadBytes }),
        aad: apiPlatformConfigurationAad("test", "merchant.knowledge.r2", version) });
      return { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: envelope.keyId,
        nonce: Buffer.from(envelope.nonce).toString("base64"), ciphertext: Buffer.from(envelope.ciphertext).toString("base64"),
        authTag: Buffer.from(envelope.authTag).toString("base64") };
    };
    await db.platformConfiguration.create({ data: { environment: "test", key: "merchant.knowledge.r2", version: 1,
      value: sealR2Configuration(1, 10000) } });
    const platformConfiguration = createApiPlatformConfigurationReader({ prisma: db, environment: "test",
      unsealEnvironment: { MODA_CONFIG_UNSEAL_KEY: wrappingKeyJson, MODA_CONFIG_UNSEAL_ACTIVE_KEY_ID: "wrapping" } });
    const objects = new Map<string, { bytes: Buffer; contentType: string; sha256: string }>();
    const r2: UploadR2 = {
      async sign({ key, contentType, sha256 }) { objects.set(key, { bytes: contentType === xlsxContentType ? xlsxBytes : bytes, contentType, sha256 }); return `https://r2.example.invalid/${key}`; },
      async verify({ key, sizeBytes, contentType, sha256 }) {
        const object = objects.get(key);
        assert.ok(object);
        assert.equal(object.bytes.length, sizeBytes);
        assert.equal(object.contentType, contentType);
        assert.equal(object.sha256, sha256);
        assert.equal(createHash("sha256").update(object.bytes).digest("hex"), sha256);
      },
    };
    let current = new Date("2026-10-17T09:00:00Z");
    const service = new MerchantKnowledgeUploadService(db, { r2, configuration: platformConfiguration,
      environment: "test", now: () => current });
    const request = parseIntent({ idempotencyKey: randomUUID(), purposeKey: "PRODUCT_INFORMATION",
      dataFormatKey: "CSV", originalFileName: "products.csv", contentType: "text/csv",
      sizeBytes: bytes.length, sha256: checksum });
    try {
      const first = await service.intent(principal, request);
      const firstObjectKey = (await db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: first.assetId } })).objectKey;
      assert.equal(firstObjectKey,
        `merchant-knowledge/test/woocommerce/${shop.id}/${marker}.upload.example.invalid/20261017T090000000Z-${first.assetId}.csv`);
      // Regenerating the key during replay would break a signed upload and create an orphan object.
      current = new Date("2026-10-17T09:00:05Z");
      const repeated = await service.intent(principal, request);
      assert.equal(first.assetId, repeated.assetId);
      assert.equal((await db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: first.assetId } })).objectKey,
        firstObjectKey);
      assert.ok(repeated.uploadUrl.includes(firstObjectKey));
      // A changed verified shop hostname does not rewrite an already-persisted key.
      const movedDomain = `https://moved-${marker}.example.invalid`;
      await db.shop.update({ where: { id: shop.id }, data: { domain: movedDomain } });
      await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { canonicalSiteUrl: movedDomain } });
      const migratedPrincipal = { ...principal, canonicalSiteUrl: movedDomain };
      assert.ok((await service.intent(migratedPrincipal, request)).uploadUrl.includes(firstObjectKey));
      await db.shop.update({ where: { id: shop.id }, data: { domain } });
      await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { canonicalSiteUrl: domain } });
      // Old PENDING_UPLOAD records from API-017 must keep working on replay.
      const oldRequest = { ...request, idempotencyKey: randomUUID() };
      const oldAssetId = deterministicAssetId(shop.id, oldRequest.idempotencyKey);
      const originalAsset = await db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: first.assetId } });
      const oldObjectKey = `merchant-knowledge/test/woocommerce/${shop.id}/${oldAssetId}/source.csv`;
      await db.merchantKnowledgeUploadedAsset.create({ data: { id: oldAssetId, shopId: shop.id,
        dataFormatId: originalAsset.dataFormatId, status: "PENDING_UPLOAD", objectKey: oldObjectKey,
        originalFileName: request.originalFileName, contentType: request.contentType,
        sizeBytes: BigInt(request.sizeBytes), sha256: request.sha256,
        uploadExpiresAt: new Date("2026-10-17T09:10:00Z") } });
      assert.ok((await service.intent(principal, oldRequest)).uploadUrl.includes(oldObjectKey));
      await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key: "merchant.knowledge.r2" } },
        data: { value: sealR2Configuration(2, 10), version: 2 } });
      await assert.rejects(() => service.intent(principal, { ...request, idempotencyKey: randomUUID() }),
        (error: unknown) => error instanceof KnowledgeUploadError && error.status === 413);
      await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key: "merchant.knowledge.r2" } },
        data: { value: sealR2Configuration(3, 10000), version: 3 } });
      const refreshed = await service.intent(principal, { ...request, idempotencyKey: randomUUID() });
      assert.equal(refreshed.maxUploadBytes, 10000);
      assert.equal((await db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: first.assetId } })).objectKey,
        firstObjectKey);
      await assert.rejects(() => service.intent(principal, { ...request, sizeBytes: 3 }),
        (error: unknown) => error instanceof KnowledgeUploadError && error.status === 409);
      const finalize = parseFinalize({ assetId: first.assetId, name: "Products", purposeKey: "PRODUCT_INFORMATION",
        languageTag: "en", contentType: "text/csv", sizeBytes: bytes.length, sha256: checksum });
      await assert.rejects(() => service.finalize(foreignPrincipal, finalize),
        (error: unknown) => error instanceof KnowledgeUploadError);
      await assert.rejects(() => service.finalize(principal, { ...finalize, sha256: "b".repeat(64) }),
        (error: unknown) => error instanceof KnowledgeUploadError && error.code === "knowledge_upload_integrity_mismatch");
      const created = await service.finalize(principal, finalize);
      assert.equal(created.status, "ACCEPTED");
      assert.equal((await service.finalize(principal, finalize)).sourceId, created.sourceId);
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { sourceId: created.sourceId } }), 1);
      assert.equal((await db.merchantKnowledgeSourceRevision.findUniqueOrThrow({
        where: { sourceId_generation: { sourceId: created.sourceId, generation: 1 } },
      })).status, "PENDING");
      const next = await service.intent(principal, { ...request, idempotencyKey: randomUUID() });
      const replaced = await service.finalize(principal, { ...finalize, assetId: next.assetId, sourceId: created.sourceId });
      assert.equal(replaced.generation, 2);
      await service.edit(principal, created.sourceId, { name: "Revised products", languageTag: "en" });
      const reprocessed = await service.reprocess(principal, created.sourceId);
      assert.equal(reprocessed.generation, 3);
      assert.equal((await db.merchantKnowledgeSource.findUniqueOrThrow({ where: { id: created.sourceId } })).name, "Revised products");
      // Merchant preference off is not a reason to reject configuration or claim ingestion.
      const preferences = await db.shopFeaturePreference.findMany({ where: { shopId: shop.id } });
      assert.equal(preferences.length, 0);
      const pending = await db.merchantKnowledgeSourceRevision.findUniqueOrThrow({
        where: { sourceId_generation: { sourceId: created.sourceId, generation: 3 } },
      });
      assert.equal(pending.status, "PENDING");
      const xlsxIntent = await service.intent(principal, parseIntent({ ...request, idempotencyKey: randomUUID(),
        dataFormatKey: "XLSX", originalFileName: "products.xlsx", contentType: xlsxContentType,
        sizeBytes: xlsxBytes.length, sha256: xlsxChecksum }));
      const xlsxSource = await service.finalize(principal, parseFinalize({ ...finalize, assetId: xlsxIntent.assetId,
        name: "XLSX products", contentType: xlsxContentType, sizeBytes: xlsxBytes.length, sha256: xlsxChecksum }));
      assert.notEqual(xlsxSource.sourceId, created.sourceId);
      assert.equal((await service.finalize(principal, parseFinalize({ ...finalize, assetId: xlsxIntent.assetId,
        name: "XLSX products", contentType: xlsxContentType, sizeBytes: xlsxBytes.length, sha256: xlsxChecksum }))).sourceId,
        xlsxSource.sourceId);
      assert.equal(await db.merchantKnowledgeSource.count({ where: { shopId: shop.id } }), 2);
      const overQuota = await service.intent(principal, { ...request, idempotencyKey: randomUUID() });
      await assert.rejects(() => service.finalize(principal, { ...finalize, assetId: overQuota.assetId }),
        (error: unknown) => error instanceof KnowledgeUploadError && error.status === 403);
      const expired = await service.intent(principal, { ...request, idempotencyKey: randomUUID() });
      current = new Date("2026-10-17T09:11:00Z");
      await assert.rejects(() => service.finalize(principal, { ...finalize, assetId: expired.assetId }),
        (error: unknown) => error instanceof KnowledgeUploadError && error.code === "knowledge_upload_expired");
      await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { status: "REVOKED", revokedAt: new Date() } });
      await assert.rejects(() => service.reprocess(principal, created.sourceId),
        (error: unknown) => error instanceof KnowledgeUploadError && error.status === 403);
    } finally {
      await db.merchantKnowledgeSourceRevision.deleteMany({ where: { source: { is: { shopId: shop.id } } } });
      await db.shop.deleteMany({ where: { id: { in: [shop.id, foreign.id] } } });
      await db.billingPlan.delete({ where: { id: plan.id } });
      await db.$disconnect();
    }
  });
