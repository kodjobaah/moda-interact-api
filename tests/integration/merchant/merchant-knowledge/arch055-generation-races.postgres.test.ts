import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { KnowledgeCommandError, KnowledgeCommandPostCommitError } from "../../../../src/merchant/merchant-knowledge/commands.contract.js";
import { MerchantKnowledgeCommandService } from "../../../../src/merchant/merchant-knowledge/commands.service.js";
import { MerchantKnowledgeReadService } from "../../../../src/merchant/merchant-knowledge/read.service.js";

const url = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const config = { schemaVersion: 1, maxKnowledgeSources: 10, maxContentUnitsPerSource: 1500,
  allowedSourceTypes: [{ purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" }] };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test("ARCH-055 conditional web writes reject Background generation advances; committed response failures stay committed",
  { skip: !url }, async () => {
    if (!url) return;
    const db = new PrismaClient({ datasources: { db: { url } } });
    const marker = randomUUID();
    const domain = `https://${marker}.generation-race.example.invalid`;
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
        shopifyPlanHandle: `arch055-race-${marker}`, name: "ARCH-055 race", kind: "PAID_METERED", active: true,
      } });
      planId = plan.id;
      await db.billingPlanFeature.create({ data: { planId, featureId: feature.id, enabled: true, configuration: config } });
      await db.subscription.create({ data: { shopId: shop.id, planId, status: "ACTIVE" } });
      const ordinary = new MerchantKnowledgeCommandService(db, new MerchantKnowledgeReadService(db));
      let readReached = deferred<void>();
      let allowWrite = deferred<void>();
      const racingDatabase = { $transaction: (handler: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) =>
        db.$transaction(async (tx) => {
          let paused = false;
          const wrapped = new Proxy(tx, { get(target, property, receiver) {
            if (property !== "merchantKnowledgeSource") return Reflect.get(target, property, receiver);
            const delegate = Reflect.get(target, property, receiver) as object;
            return new Proxy(delegate, { get(sourceDelegate, method, sourceReceiver) {
              if (method !== "findFirst") return Reflect.get(sourceDelegate, method, sourceReceiver);
              const findFirst = Reflect.get(sourceDelegate, method, sourceReceiver) as (...args: unknown[]) => Promise<unknown>;
              return async (...args: unknown[]) => {
                const row = await findFirst.apply(sourceDelegate, args);
                if (!paused) {
                  paused = true;
                  readReached.resolve();
                  await allowWrite.promise;
                }
                return row;
              };
            } });
          } });
          return handler(wrapped);
        }, options as never) };
      const racing = new MerchantKnowledgeCommandService(racingDatabase as never, new MerchantKnowledgeReadService(db));
      const staleWrites = [
        ["metadata patch", (sourceId: string) => racing.patch(principal, sourceId, { expectedGeneration: 1, name: "stale name" })],
        ["URL patch", (sourceId: string) => racing.patch(principal, sourceId, { expectedGeneration: 1, url: "https://example.invalid/stale" })],
        ["refresh", (sourceId: string) => racing.refresh(principal, sourceId, { expectedGeneration: 1 })],
        ["delete", (sourceId: string) => racing.remove(principal, sourceId, { expectedGeneration: 1 })],
      ] as const;
      for (const [label, operation] of staleWrites) {
        const originalUrl = `https://example.invalid/${encodeURIComponent(label)}`;
        const created = await ordinary.create(principal, { name: `FAQ ${label}`, purposeKey: "FAQ", dataFormatKey: "WEB_PAGE", url: originalUrl });
        const sourceId = created.sourceId!;
        await db.merchantKnowledgeSourceRevision.update({ where: { sourceId_generation: { sourceId, generation: 1 } },
          data: { status: "FAILED", failureCode: "HTTP_5XX" } });
        readReached = deferred<void>();
        allowWrite = deferred<void>();
        const write = operation(sourceId);
        await readReached.promise;
        await db.$transaction(async (tx) => {
          const changed = await tx.merchantKnowledgeSource.updateMany({ where: { id: sourceId, shopId: shop.id, currentGeneration: 1 },
            data: { currentGeneration: 2 } });
          assert.equal(changed.count, 1, label);
          await tx.merchantKnowledgeSourceRevision.create({ data: { sourceId, generation: 2, reason: "REFRESH",
            requestedUrl: originalUrl, status: "PENDING", requestedAt: new Date() } });
        });
        allowWrite.resolve();
        await assert.rejects(() => write, (error: unknown) => error instanceof KnowledgeCommandError && error.status === 409, label);
        const after = await db.merchantKnowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
        assert.equal(after.currentGeneration, 2, label);
        assert.equal(after.name === "stale name", false, label);
        assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { sourceId } }), 2, label);
        assert.equal((await db.merchantKnowledgeSourceRevision.findUniqueOrThrow({ where: { sourceId_generation: { sourceId, generation: 1 } } })).requestedUrl,
          originalUrl, label);
      }

      const committed = await ordinary.create(principal, { name: "Postcommit", purposeKey: "FAQ", dataFormatKey: "WEB_PAGE", url: "https://example.invalid/postcommit" });
      const failedProjection = new MerchantKnowledgeCommandService(db, { async read() { throw new Error("projection failed after commit"); } } as never);
      await assert.rejects(() => failedProjection.patch(principal, committed.sourceId!, { expectedGeneration: 1,
        url: "https://example.invalid/postcommit-updated" }),
      (error: unknown) => error instanceof KnowledgeCommandPostCommitError && error.committed);
      assert.equal((await db.merchantKnowledgeSource.findUniqueOrThrow({ where: { id: committed.sourceId! } })).currentGeneration, 2);
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { sourceId: committed.sourceId! } }), 2);
      await ordinary.patch(principal, committed.sourceId!, { expectedGeneration: 2, name: "Committed once" });
      assert.equal((await db.merchantKnowledgeSource.findUniqueOrThrow({ where: { id: committed.sourceId! } })).currentGeneration, 2);
    } finally {
      await db.merchantKnowledgeSourceRevision.deleteMany({ where: { source: { is: { shopId: shop.id } } } });
      await db.shop.delete({ where: { id: shop.id } });
      if (planId) await db.billingPlan.delete({ where: { id: planId } });
      await db.$disconnect();
    }
  });
