import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { MerchantKnowledgeUploadService } from "../../../../src/merchant/merchant-knowledge/upload.service.js";
import { KnowledgeUploadError, parseFinalize, parseIntent } from "../../../../src/merchant/merchant-knowledge/upload-contract.js";
import type { UploadR2 } from "../../../../src/merchant/merchant-knowledge/upload-r2.js";

const url = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const config = { endpoint: "https://r2.example.invalid", bucket: "knowledge", accessKeyId: "test", secretAccessKey: "test",
  maxUploadBytes: 10000 };
const featureConfig = { schemaVersion: 1, maxKnowledgeSources: 2, maxContentUnitsPerSource: 1500,
  allowedSourceTypes: [{ purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "CSV" }] };
const deferred = <T = void,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test("ARCH-055 finalization cannot resurrect an upload after cleanup wins the asset lock",
  { skip: !url }, async () => {
    if (!url) return;
    const db = new PrismaClient({ datasources: { db: { url } } });
    const marker = randomUUID();
    const domain = `https://${marker}.upload-race.example.invalid`;
    const shop = await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE" } });
    let planId: string | undefined;
    let assetId: string | undefined;
    const createdAssetIds: string[] = [];
    try {
      const installation = await db.wooCommerceInstallation.create({ data: {
        shopId: shop.id, canonicalSiteUrl: domain, credentialDigest: Buffer.alloc(32), credentialVersion: 1,
      } });
      const principal = { shopId: shop.id, installationId: installation.id, canonicalSiteUrl: domain, credentialVersion: 1 };
      const feature = await db.feature.upsert({ where: { key: "merchant_knowledge" }, create: {
        key: "merchant_knowledge", displayName: "Merchant Knowledge", active: true, activationMode: "MERCHANT_OPT_IN",
      }, update: { active: true, activationMode: "MERCHANT_OPT_IN" } });
      const plan = await db.billingPlan.create({ data: {
        shopifyPlanHandle: `arch055-upload-${marker}`, name: "ARCH-055 upload", kind: "PAID_METERED", active: true,
      } });
      planId = plan.id;
      await db.billingPlanFeature.create({ data: { planId, featureId: feature.id, enabled: true, configuration: featureConfig } });
      await db.subscription.create({ data: { shopId: shop.id, planId, status: "ACTIVE" } });
      const payload = Buffer.from("sku,description\n1,Example\n");
      const sha256 = createHash("sha256").update(payload).digest("hex");
      const objects = new Map<string, Buffer>();
      let verificationTarget: string | null = null;
      let verificationReached = deferred();
      let allowVerification = deferred();
      const r2: UploadR2 = {
        async sign({ key }) { objects.set(key, payload); return `https://r2.example.invalid/${key}`; },
        async verify({ key, sizeBytes, sha256: expected }) {
          if (key === verificationTarget) {
            verificationReached.resolve();
            await allowVerification.promise;
          }
          const bytes = objects.get(key);
          assert.ok(bytes);
          assert.equal(bytes.length, sizeBytes);
          assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
        },
      };
      const base = new MerchantKnowledgeUploadService(db, { r2, config, environment: "test" });
      const intent = await base.intent(principal, parseIntent({ idempotencyKey: randomUUID(), purposeKey: "PRODUCT_INFORMATION",
        dataFormatKey: "CSV", originalFileName: "products.csv", contentType: "text/csv", sizeBytes: payload.length, sha256 }));
      assetId = intent.assetId;
      createdAssetIds.push(assetId);
      const finalize = parseFinalize({ assetId, name: "Products", purposeKey: "PRODUCT_INFORMATION", languageTag: "en",
        contentType: "text/csv", sizeBytes: payload.length, sha256 });

      const releaseCleanup = deferred();
      const cleanupLocked = deferred();
      const cleanup = db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "commerce"."MerchantKnowledgeUploadedAsset" WHERE "id" = ${assetId} FOR UPDATE`);
        cleanupLocked.resolve();
        await releaseCleanup.promise;
        await tx.merchantKnowledgeUploadedAsset.update({ where: { id: assetId! }, data: { status: "DELETED" } });
      });
      await cleanupLocked.promise;

      let finalLockAttempt = deferred();
      const finalizationDatabase = { $transaction: (handler: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) =>
        db.$transaction((tx) => handler(new Proxy(tx, { get(target, property, receiver) {
          if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
          return (query: Prisma.Sql) => {
            if (query.sql.includes('"MerchantKnowledgeUploadedAsset"') && query.sql.includes("FOR NO KEY UPDATE")) {
              finalLockAttempt.resolve();
            }
            return target.$queryRaw(query);
          };
        } })) as never, options as never) };
      const racing = new MerchantKnowledgeUploadService(finalizationDatabase as never, { r2, config, environment: "test" });
      const finalizing = racing.finalize(principal, finalize);
      await finalLockAttempt.promise;
      releaseCleanup.resolve();
      await cleanup;
      await assert.rejects(() => finalizing,
        (error: unknown) => error instanceof KnowledgeUploadError && error.status === 409);
      assert.equal((await db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: assetId } })).status, "DELETED");
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { uploadedAssetId: assetId } }), 0);

      const expiring = await base.intent(principal, parseIntent({ idempotencyKey: randomUUID(), purposeKey: "PRODUCT_INFORMATION",
        dataFormatKey: "CSV", originalFileName: "products.csv", contentType: "text/csv", sizeBytes: payload.length, sha256 }));
      const expiringAssetId = expiring.assetId;
      createdAssetIds.push(expiringAssetId);
      const expiringFinalize = { ...finalize, assetId: expiringAssetId };
      const releaseExpiry = deferred();
      const expiryLockHeld = deferred();
      const expiryCleanup = db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "commerce"."MerchantKnowledgeUploadedAsset" WHERE "id" = ${expiringAssetId} FOR UPDATE`);
        expiryLockHeld.resolve();
        await releaseExpiry.promise;
        await tx.merchantKnowledgeUploadedAsset.update({ where: { id: expiringAssetId },
          data: { uploadExpiresAt: new Date(Date.now() - 1000) } });
      });
      await expiryLockHeld.promise;
      finalLockAttempt = deferred();
      const expiringFinalization = racing.finalize(principal, expiringFinalize);
      await finalLockAttempt.promise;
      releaseExpiry.resolve();
      await expiryCleanup;
      await assert.rejects(() => expiringFinalization,
        (error: unknown) => error instanceof KnowledgeUploadError && error.code === "knowledge_upload_expired");
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { uploadedAssetId: expiringAssetId } }), 0);
      assert.equal((await db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: expiringAssetId } })).status, "PENDING_UPLOAD");
      await db.merchantKnowledgeUploadedAsset.delete({ where: { id: expiringAssetId } });

      const mimeIntent = await base.intent(principal, parseIntent({ idempotencyKey: randomUUID(), purposeKey: "PRODUCT_INFORMATION",
        dataFormatKey: "CSV", originalFileName: "products.csv", contentType: "text/csv", sizeBytes: payload.length, sha256 }));
      createdAssetIds.push(mimeIntent.assetId);
      const mimeAsset = await db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: mimeIntent.assetId } });
      const formatBefore = await db.merchantKnowledgeDataFormat.findUniqueOrThrow({ where: { id: mimeAsset.dataFormatId },
        select: { acceptedContentTypes: true } });
      verificationTarget = mimeAsset.objectKey;
      verificationReached = deferred();
      allowVerification = deferred();
      const mimeFinalization = base.finalize(principal, { ...finalize, assetId: mimeIntent.assetId });
      await verificationReached.promise;
      await db.merchantKnowledgeDataFormat.update({ where: { id: mimeAsset.dataFormatId }, data: { acceptedContentTypes: ["application/csv"] } });
      allowVerification.resolve();
      try {
        await assert.rejects(() => mimeFinalization,
          (error: unknown) => error instanceof KnowledgeUploadError && error.status === 403);
      } finally {
        await db.merchantKnowledgeDataFormat.update({ where: { id: mimeAsset.dataFormatId },
          data: { acceptedContentTypes: formatBefore.acceptedContentTypes as never } });
      }
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { uploadedAssetId: mimeIntent.assetId } }), 0);
      assert.equal((await db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: mimeIntent.assetId } })).status, "PENDING_UPLOAD");
      await db.merchantKnowledgeUploadedAsset.delete({ where: { id: mimeIntent.assetId } });

      const completing = await base.intent(principal, parseIntent({ idempotencyKey: randomUUID(), purposeKey: "PRODUCT_INFORMATION",
        dataFormatKey: "CSV", originalFileName: "products.csv", contentType: "text/csv", sizeBytes: payload.length, sha256 }));
      createdAssetIds.push(completing.assetId);
      const completingFinalize = { ...finalize, assetId: completing.assetId };
      const assetReadHeld = deferred();
      const allowFinalCommit = deferred();
      let transactionNumber = 0;
      const finalizerDatabase = { $transaction: (handler: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) => {
        transactionNumber++;
        return db.$transaction(async (tx) => {
          if (transactionNumber !== 2) return handler(tx);
          const wrapped = new Proxy(tx, { get(target, property, receiver) {
            if (property !== "merchantKnowledgeUploadedAsset") return Reflect.get(target, property, receiver);
            const delegate = Reflect.get(target, property, receiver) as object;
            return new Proxy(delegate, { get(sourceDelegate, method, sourceReceiver) {
              if (method !== "findFirst") return Reflect.get(sourceDelegate, method, sourceReceiver);
              const findFirst = Reflect.get(sourceDelegate, method, sourceReceiver) as (...args: unknown[]) => Promise<unknown>;
              return async (...args: unknown[]) => {
                const row = await findFirst.apply(sourceDelegate, args);
                assetReadHeld.resolve();
                await allowFinalCommit.promise;
                return row;
              };
            } });
          } });
          return handler(wrapped);
        }, options as never);
      } };
      const finalizer = new MerchantKnowledgeUploadService(finalizerDatabase as never, { r2, config, environment: "test" });
      const finalizing = finalizer.finalize(principal, completingFinalize);
      await assetReadHeld.promise;
      const cleanupQueryStarted = deferred<number>();
      let cleanupSawAvailable = false;
      const cleanupWinsLater = db.$transaction(async (tx) => {
        const pid = await tx.$queryRaw<Array<{ pid: number }>>(Prisma.sql`SELECT pg_backend_pid() AS pid`);
        const lock = tx.$queryRaw(Prisma.sql`SELECT "id" FROM "commerce"."MerchantKnowledgeUploadedAsset"
          WHERE "id" = ${completing.assetId} FOR UPDATE`);
        cleanupQueryStarted.resolve(pid[0]!.pid);
        await lock;
        const state = await tx.merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: completing.assetId }, select: { status: true } });
        cleanupSawAvailable = state.status === "AVAILABLE";
        if (!cleanupSawAvailable) await tx.merchantKnowledgeUploadedAsset.update({ where: { id: completing.assetId }, data: { status: "DELETED" } });
      });
      const cleanupPid = await cleanupQueryStarted.promise;
      let observedLockWait = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const activity = await db.$queryRaw<Array<{ wait_event_type: string | null }>>(Prisma.sql`
          SELECT "wait_event_type" FROM "pg_catalog"."pg_stat_activity" WHERE "pid" = ${cleanupPid}
        `);
        if (activity[0]?.wait_event_type === "Lock") { observedLockWait = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      try {
        assert.equal(observedLockWait, true, "cleanup must be blocked on the asset row lock held by finalization");
      } finally { allowFinalCommit.resolve(); }
      const accepted = await finalizing;
      await cleanupWinsLater;
      assert.equal(accepted.status, "ACCEPTED");
      assert.equal(cleanupSawAvailable, true);
      assert.equal((await db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: completing.assetId } })).status, "AVAILABLE");
      assert.equal(await db.merchantKnowledgeSourceRevision.count({ where: { uploadedAssetId: completing.assetId } }), 1);
    } finally {
      if (createdAssetIds.length) await db.merchantKnowledgeUploadedAsset.deleteMany({ where: { id: { in: createdAssetIds } } });
      await db.shop.delete({ where: { id: shop.id } });
      if (planId) await db.billingPlan.delete({ where: { id: planId } });
      await db.$disconnect();
    }
  });
