import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { MerchantKnowledgeReadService } from "../../../../src/merchant/merchant-knowledge/read.service.js";
import { MerchantKnowledgeReadError } from "../../../../src/merchant/merchant-knowledge/contract.js";

const url = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const config = { schemaVersion: 1, maxKnowledgeSources: 1, maxContentUnitsPerSource: 1500,
  allowedSourceTypes: [{ purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" },
    { purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "CSV" }] };

test("migration-backed Woo Merchant Knowledge read: tenant, entitlement, revisions, activation, formats and secrets",
  { skip: !url }, async () => {
    if (!url) return;
    const db = new PrismaClient({ datasources: { db: { url } } });
    const marker = randomUUID();
    const domain = `https://${marker}.knowledge-test.invalid`;
    const woo = await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE", defaultLanguageTag: "en" } });
    const other = await db.shop.create({ data: { domain: `${domain}-other`, platform: "WOOCOMMERCE", status: "ACTIVE" } });
    let planId: string | undefined;
    try {
      const installation = await db.wooCommerceInstallation.create({ data: {
        shopId: woo.id, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32), credentialVersion: 3,
      } });
      const otherInstallation = await db.wooCommerceInstallation.create({ data: {
        shopId: other.id, canonicalSiteUrl: `${domain}-other`, credentialDigest: Buffer.alloc(32),
      } });
      const principal = { shopId: woo.id, installationId: installation.id, canonicalSiteUrl: domain, credentialVersion: 3 };
      const foreignPrincipal = { shopId: other.id, installationId: otherInstallation.id,
        canonicalSiteUrl: `${domain}-other`, credentialVersion: 1 };
      const feature = await db.feature.upsert({ where: { key: "merchant_knowledge" },
        create: { key: "merchant_knowledge", displayName: "Merchant Knowledge", active: true,
          activationMode: "MERCHANT_OPT_IN" },
        update: { active: true, activationMode: "MERCHANT_OPT_IN" } });
      const plan = await db.billingPlan.create({ data: {
        shopifyPlanHandle: `test-knowledge-${marker}`, name: "Knowledge test", kind: "PAID_METERED", active: true,
      } });
      planId = plan.id;
      await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id, enabled: true, configuration: config } });
      await db.subscription.create({ data: { shopId: woo.id, planId: plan.id, status: "ACTIVE" } });
      const faq = await db.merchantKnowledgePurpose.findUniqueOrThrow({ where: { key: "FAQ" } });
      const products = await db.merchantKnowledgePurpose.findUniqueOrThrow({ where: { key: "PRODUCT_INFORMATION" } });
      const web = await db.merchantKnowledgeDataFormat.findUniqueOrThrow({ where: { key: "WEB_PAGE" } });
      const csv = await db.merchantKnowledgeDataFormat.findUniqueOrThrow({ where: { key: "CSV" } });
      const source = await db.merchantKnowledgeSource.create({ data: {
        shopId: woo.id, purposeId: faq.id, dataFormatId: web.id, name: "FAQ", languageTag: "en", position: 1,
        currentGeneration: 2,
      } });
      const uploadSource = await db.merchantKnowledgeSource.create({ data: {
        shopId: woo.id, purposeId: products.id, dataFormatId: csv.id, name: "Products", languageTag: "en", position: 2,
        currentGeneration: 1,
      } });
      const unrelated = await db.merchantKnowledgeSource.create({ data: {
        shopId: other.id, purposeId: faq.id, dataFormatId: web.id, name: "Other tenant private FAQ",
        languageTag: "en", position: 1, currentGeneration: 0,
      } });
      await db.merchantKnowledgeSourceRevision.create({ data: {
        sourceId: source.id, generation: 1, reason: "CREATE", status: "ACTIVE",
        requestedUrl: "https://faq.example.com/page", contentUnits: 55,
        contentHash: createHash("sha256").update("Merchant Knowledge FAQ test fixture").digest("hex"),
        fetchedAt: new Date("2026-10-01T00:00:00Z"),
      } });
      await db.merchantKnowledgeSourceRevision.create({ data: {
        sourceId: source.id, generation: 2, reason: "REFRESH", status: "FAILED",
        requestedUrl: "https://faq.example.com/page?token=TOP_SECRET", failureCode: "HTTP_5XX",
      } });
      const asset = await db.merchantKnowledgeUploadedAsset.create({ data: {
        shopId: woo.id, dataFormatId: csv.id, objectKey: `private/${marker}/product.csv`,
        originalFileName: "product.csv", status: "AVAILABLE", contentType: "text/csv",
        sizeBytes: BigInt(128), sha256: createHash("sha256").update("id,product\n1,test\n").digest("hex"),
        availableAt: new Date("2026-10-01T00:00:00Z"), uploadExpiresAt: new Date("2026-11-01T00:00:00Z"),
      } });
      await db.merchantKnowledgeSourceRevision.create({ data: {
        sourceId: uploadSource.id, generation: 1, reason: "CREATE", status: "PENDING",
        uploadedAssetId: asset.id,
      } });
      const service = new MerchantKnowledgeReadService(db, "4096");
      let read = await service.read(principal);
      assert.equal(read.planEntitled, true);
      assert.equal(read.state, "MERCHANT_DISABLED");
      assert.equal(read.maxKnowledgeSources, 1);
      assert.equal(read.configuredCount, 2);
      assert.equal(read.planEligibleSourceCount, 2);
      assert.equal(read.catalogue.some((entry) => entry.dataFormat.key === "CSV"), true);
      assert.equal(read.sources[0]?.revision?.status, "FAILED");
      assert.equal(read.sources[0]?.revision?.failureCode, "HTTP_5XX");
      assert.equal(read.sources[0]?.activeRevision?.generation, 1);
      assert.equal(read.sources[0]?.revision?.activeContentUnits, 55);
      assert.equal(read.sources[0]?.revision?.requestedUrl, "https://faq.example.com/page");
      assert.equal(read.sources[0]?.dormantReason, "MERCHANT_DISABLED");
      assert.equal(read.sources[1]?.dormantReason, "SOURCE_COUNT");
      assert.equal(read.sources[1]?.uploadedFileName, "product.csv");
      assert.equal(read.sources.every((entry) => entry.processingEligible === false), true);
      assert.equal(JSON.stringify(read).includes("TOP_SECRET"), false);
      assert.equal(JSON.stringify(read).includes(asset.objectKey), false);
      assert.equal(JSON.stringify(read).includes(unrelated.name), false);
      const another = await service.read(foreignPrincipal);
      assert.equal(another.configuredCount, 1);
      assert.equal(another.sources[0]?.id, unrelated.id);
      assert.equal(another.planEntitled, false);
      await db.shopFeaturePreference.create({ data: { shopId: woo.id, featureId: feature.id, enabled: true } });
      read = await service.read(principal);
      assert.equal(read.state, "ENABLED");
      assert.equal(read.sources[0]?.processingEligible, true);
      assert.equal(read.sources[1]?.processingEligible, false);
      await db.subscription.update({ where: { shopId: woo.id }, data: { status: "NO_CONTRACT" } });
      read = await service.read(principal);
      assert.equal(read.state, "PLAN_UNENTITLED");
      assert.equal(read.configuredCount, 2);
      assert.equal(read.catalogue.length, 0);
      assert.equal(read.sources.every((entry) => entry.dormantReason === "NO_CURRENT_PLAN"), true);
      await db.subscription.update({ where: { shopId: woo.id }, data: { status: "ACTIVE" } });
      await db.billingPlanFeature.update({ where: { planId_featureId: { planId: plan.id, featureId: feature.id } },
        data: { configuration: { ...config, maxKnowledgeSources: 0 } } });
      await assert.rejects(() => service.read(principal), (error: unknown) =>
        error instanceof MerchantKnowledgeReadError && error.status === 503);
      await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { credentialVersion: 4 } });
      await assert.rejects(() => service.read(principal), (error: unknown) =>
        error instanceof MerchantKnowledgeReadError && error.status === 409);
    } finally {
      // Revisions reference uploaded assets with ON DELETE RESTRICT; remove them before shop cascades.
      await db.merchantKnowledgeSourceRevision.deleteMany({
        where: { source: { is: { shopId: { in: [woo.id, other.id] } } } },
      });
      await db.shop.deleteMany({ where: { id: { in: [woo.id, other.id] } } });
      if (planId) await db.billingPlan.delete({ where: { id: planId } });
      await db.$disconnect();
    }
  });
