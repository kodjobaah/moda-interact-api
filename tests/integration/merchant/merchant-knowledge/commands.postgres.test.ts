import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { KnowledgeCommandError } from "../../../../src/merchant/merchant-knowledge/commands.contract.js";
import { MerchantKnowledgeCommandService } from "../../../../src/merchant/merchant-knowledge/commands.service.js";
import { MerchantKnowledgeReadService } from "../../../../src/merchant/merchant-knowledge/read.service.js";

const url = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const config = { schemaVersion: 1, maxKnowledgeSources: 2, maxContentUnitsPerSource: 1500,
  allowedSourceTypes: [{ purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" }] };

test("migration-backed Woo web-source commands: concurrent dedup, pending revisions, CAS, scope and ordering",
  { skip: !url }, async () => {
    if (!url) return;
    const db = new PrismaClient({ datasources: { db: { url } } });
    const marker = randomUUID();
    const domain = `https://${marker}.merchant-knowledge.example.org`;
    const woo = await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE", defaultLanguageTag: "en" } });
    const other = await db.shop.create({ data: { domain: `https://${marker}.other.example.org`, platform: "WOOCOMMERCE", status: "ACTIVE" } });
    let planId: string | undefined;
    try {
      const installed = await db.wooCommerceInstallation.create({ data: {
        shopId: woo.id, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32), credentialVersion: 1,
      } });
      const principal = { shopId: woo.id, canonicalSiteUrl: domain, installationId: installed.id, credentialVersion: 1 };
      const feature = await db.feature.upsert({ where: { key: "merchant_knowledge" }, create: {
        key: "merchant_knowledge", displayName: "Merchant Knowledge", active: true, activationMode: "MERCHANT_OPT_IN",
      }, update: { active: true, activationMode: "MERCHANT_OPT_IN" } });
      const plan = await db.billingPlan.create({ data: {
        shopifyPlanHandle: `knowledge-cmd-${marker}`, name: "Knowledge write test", kind: "PAID_METERED", active: true,
      } });
      planId = plan.id;
      await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id, enabled: true, configuration: config } });
      await db.subscription.create({ data: { shopId: woo.id, planId: plan.id, status: "ACTIVE" } });
      const faq = await db.merchantKnowledgePurpose.findUniqueOrThrow({ where: { key: "FAQ" } });
      const web = await db.merchantKnowledgeDataFormat.findUniqueOrThrow({ where: { key: "WEB_PAGE" } });
      const foreign = await db.merchantKnowledgeSource.create({ data: {
        shopId: other.id, purposeId: faq.id, dataFormatId: web.id, name: "Private", position: 0,
        languageTag: "en", currentGeneration: 1,
      } });
      const service = new MerchantKnowledgeCommandService(db, new MerchantKnowledgeReadService(db));
      const input = { name: "Shop FAQ", purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" as const, url: "https://example.org/help" };
      const [first, second] = await Promise.all([service.create(principal, input), service.create(principal, input)]);
      assert.equal(first.sourceId, second.sourceId);
      assert.deepEqual([first.created, second.created].sort(), [false, true]);
      const sourceId = first.sourceId!;
      assert.equal(await db.merchantKnowledgeSource.count({ where: { shopId: woo.id } }), 1);
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { sourceId } }), 1);
      let latest = await db.merchantKnowledgeSourceRevision.findFirstOrThrow({ where: { sourceId } });
      assert.equal(latest.status, "PENDING"); // No queue or feature preference required for durable reconciliation.
      assert.equal(first.knowledge.state, "MERCHANT_DISABLED");
      await assert.rejects(() => service.patch(principal, foreign.id, { expectedGeneration: 1, name: "Foreign" }),
        (error: unknown) => error instanceof KnowledgeCommandError && error.status === 404);
      await assert.rejects(() => service.patch(principal, sourceId, { expectedGeneration: 2, name: "Stale" }),
        (error: unknown) => error instanceof KnowledgeCommandError && error.status === 409);
      await service.patch(principal, sourceId, { expectedGeneration: 1, name: "FAQ edited" });
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { sourceId } }), 1);
      // A successfully acquired older generation must survive a URL change as active history.
      await db.merchantKnowledgeSourceRevision.update({ where: { id: latest.id }, data: {
        status: "ACTIVE", contentUnits: 32,
        contentHash: createHash("sha256").update("test content").digest("hex"), fetchedAt: new Date(),
      } });
      const changed = await service.patch(principal, sourceId, { expectedGeneration: 1, url: "https://example.org/new" });
      assert.equal(changed.knowledge.sources.find((row) => row.id === sourceId)?.activeRevision?.generation, 1);
      assert.equal(changed.knowledge.sources.find((row) => row.id === sourceId)?.revision?.status, "PENDING");
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { sourceId } }), 2);
      await service.refresh(principal, sourceId, { expectedGeneration: 2 });
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { sourceId } }), 2); // dedup while pending
      latest = await db.merchantKnowledgeSourceRevision.findFirstOrThrow({ where: { sourceId, generation: 2 } });
      await db.merchantKnowledgeSourceRevision.update({ where: { id: latest.id }, data: { status: "FAILED", failureCode: "HTTP_5XX" } });
      const refreshes = await Promise.allSettled([
        service.refresh(principal, sourceId, { expectedGeneration: 2 }),
        service.refresh(principal, sourceId, { expectedGeneration: 2 }),
      ]);
      assert.equal(refreshes.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(refreshes.filter((result) => result.status === "rejected" &&
        result.reason instanceof KnowledgeCommandError && result.reason.status === 409).length, 1);
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { sourceId } }), 3);
      const secondSource = await service.create(principal, { ...input, name: "Second FAQ", url: "https://example.org/second" });
      await assert.rejects(() => service.create(principal, { ...input, name: "Exceeds limit", url: "https://example.org/third" }),
        (error: unknown) => error instanceof KnowledgeCommandError && error.status === 403);
      await assert.rejects(() => service.order(principal, { sourceIds: [sourceId, foreign.id] }),
        (error: unknown) => error instanceof KnowledgeCommandError && error.status === 409);
      await service.order(principal, { sourceIds: [secondSource.sourceId!, sourceId] });
      assert.deepEqual((await db.merchantKnowledgeSource.findMany({ where: { shopId: woo.id }, orderBy: { position: "asc" } }))
        .map(({ id, position }) => [id, position]), [[secondSource.sourceId, 0], [sourceId, 1]]);
      await service.remove(principal, sourceId, { expectedGeneration: 3 });
      assert.deepEqual((await db.merchantKnowledgeSource.findMany({ where: { shopId: woo.id } })).map(({ position }) => position), [0]);
      await db.subscription.update({ where: { shopId: woo.id }, data: { status: "NO_CONTRACT" } });
      await assert.rejects(() => service.create(principal, { ...input, name: "Denied" }),
        (error: unknown) => error instanceof KnowledgeCommandError && error.status === 403);
      assert.equal(await db.merchantKnowledgeSource.count({ where: { shopId: woo.id } }), 1);
      assert.equal((await db.merchantKnowledgeSource.findUnique({ where: { id: foreign.id } }))?.name, "Private");
    } finally {
      await db.merchantKnowledgeSourceRevision.deleteMany({ where: { source: { is: { shopId: { in: [woo.id, other.id] } } } } });
      await db.shop.deleteMany({ where: { id: { in: [woo.id, other.id] } } });
      if (planId) await db.billingPlan.delete({ where: { id: planId } });
      await db.$disconnect();
    }
  });
