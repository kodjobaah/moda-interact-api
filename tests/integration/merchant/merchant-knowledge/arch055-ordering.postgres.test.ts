import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { MerchantKnowledgeCommandService } from "../../../../src/merchant/merchant-knowledge/commands.service.js";
import { MerchantKnowledgeReadService } from "../../../../src/merchant/merchant-knowledge/read.service.js";

const url = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const config = { schemaVersion: 1, maxKnowledgeSources: 100, maxContentUnitsPerSource: 1500,
  allowedSourceTypes: [{ purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" }] };

test("ARCH-055 ordering writes only changed rows and deleting the tail does not rewrite survivors",
  { skip: !url }, async () => {
    if (!url) return;
    const db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] });
    const statements: string[] = [];
    db.$on("query", (event) => statements.push(event.query));
    const marker = randomUUID();
    const domain = `https://${marker}.ordering.example.invalid`;
    const shop = await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE" } });
    let planId: string | undefined;
    try {
      const installation = await db.wooCommerceInstallation.create({ data: {
        shopId: shop.id, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32), credentialVersion: 1,
      } });
      const principal = { shopId: shop.id, installationId: installation.id, canonicalSiteUrl: domain, credentialVersion: 1 };
      const feature = await db.feature.upsert({ where: { key: "merchant_knowledge" }, create: {
        key: "merchant_knowledge", displayName: "Merchant Knowledge", active: true, activationMode: "MERCHANT_OPT_IN",
      }, update: { active: true, activationMode: "MERCHANT_OPT_IN" } });
      const plan = await db.billingPlan.create({ data: {
        shopifyPlanHandle: `arch055-order-${marker}`, name: "ARCH-055 ordering", kind: "PAID_METERED", active: true,
      } });
      planId = plan.id;
      await db.billingPlanFeature.create({ data: { planId, featureId: feature.id, enabled: true, configuration: config } });
      await db.subscription.create({ data: { shopId: shop.id, planId, status: "ACTIVE" } });
      const purpose = await db.merchantKnowledgePurpose.findUniqueOrThrow({ where: { key: "FAQ" } });
      const format = await db.merchantKnowledgeDataFormat.findUniqueOrThrow({ where: { key: "WEB_PAGE" } });
      const ids: string[] = [];
      for (let index = 0; index < 100; index++) {
        const id = randomUUID();
        ids.push(id);
        await db.merchantKnowledgeSource.create({ data: { id, shopId: shop.id, purposeId: purpose.id,
          dataFormatId: format.id, name: `FAQ ${index}`, languageTag: "en", position: index, currentGeneration: 1 } });
        await db.merchantKnowledgeSourceRevision.create({ data: { sourceId: id, generation: 1, reason: "CREATE",
          requestedUrl: `https://example.invalid/${index}`, status: "PENDING", requestedAt: new Date() } });
      }
      const service = new MerchantKnowledgeCommandService(db, new MerchantKnowledgeReadService(db));
      const before = await db.merchantKnowledgeSource.findMany({ where: { shopId: shop.id }, orderBy: { position: "asc" },
        select: { id: true, position: true, updatedAt: true } });
      statements.length = 0;
      await service.order(principal, { sourceIds: [ids[1]!, ids[0]!, ...ids.slice(2)] });
      const orderingUpdates = statements.filter((sql) => /UPDATE\s+"commerce"\."MerchantKnowledgeSource"/i.test(sql));
      assert.equal(orderingUpdates.length, 4);
      const afterSwap = await db.merchantKnowledgeSource.findMany({ where: { shopId: shop.id }, orderBy: { position: "asc" },
        select: { id: true, position: true, updatedAt: true } });
      assert.deepEqual(afterSwap.slice(0, 2).map(({ id, position }) => [id, position]), [[ids[1], 0], [ids[0], 1]]);
      for (const row of before.slice(2)) {
        assert.equal(afterSwap.find(({ id }) => id === row.id)?.updatedAt.getTime(), row.updatedAt.getTime());
      }
      statements.length = 0;
      await service.remove(principal, ids[99]!, { expectedGeneration: 1 });
      assert.equal(statements.filter((sql) => /UPDATE\s+"commerce"\."MerchantKnowledgeSource"/i.test(sql)).length, 0);
      const afterTailDelete = await db.merchantKnowledgeSource.findMany({ where: { shopId: shop.id },
        select: { id: true, position: true, updatedAt: true } });
      for (const row of afterSwap.filter(({ id }) => id !== ids[99])) {
        assert.equal(afterTailDelete.find(({ id }) => id === row.id)?.updatedAt.getTime(), row.updatedAt.getTime());
      }
    } finally {
      await db.merchantKnowledgeSourceRevision.deleteMany({ where: { source: { is: { shopId: shop.id } } } });
      await db.shop.delete({ where: { id: shop.id } });
      if (planId) await db.billingPlan.delete({ where: { id: planId } });
      await db.$disconnect();
    }
  });
