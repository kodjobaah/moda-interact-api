import assert from "node:assert/strict";
import test from "node:test";
import { MerchantKnowledgeUploadService } from "../../../../src/merchant/merchant-knowledge/upload.service.js";
import { KnowledgeUploadError } from "../../../../src/merchant/merchant-knowledge/upload-contract.js";

const principal = {
  shopId: "shop-one", installationId: "installation-one",
  canonicalSiteUrl: "https://shop.example.test", credentialVersion: 1,
};
const sourceId = "source-one";
const assetId = "asset-one";
const configuration = {
  schemaVersion: 1, maxKnowledgeSources: 10, maxContentUnitsPerSource: 1500,
  allowedSourceTypes: [{ purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "XLSX" }],
};

function fixture(options: { failRevisionInsert?: boolean; simultaneousReaders?: number; revoked?: boolean } = {}) {
  let generation = 1;
  const revisions: Array<{ sourceId: string; generation: number; reason: string; uploadedAssetId: string }> = [];
  const operations: string[] = [];
  let waiting = 0;
  let releaseReaders: () => void = () => {};
  const readerGate = new Promise<void>((resolve) => { releaseReaders = resolve; });
  const read = (label: string) => { operations.push(label); };
  const database = {
    shop: { async findUnique() {
      read("shop.findUnique");
      return { id: principal.shopId, domain: principal.canonicalSiteUrl, platform: "WOOCOMMERCE",
        shopifyShopId: null, status: "ACTIVE", defaultLanguageTag: "en" };
    } },
    wooCommerceInstallation: { async findUnique() {
      read("wooCommerceInstallation.findUnique");
      return { id: principal.installationId, shopId: principal.shopId,
        canonicalSiteUrl: principal.canonicalSiteUrl, credentialVersion: principal.credentialVersion,
        status: options.revoked ? "REVOKED" : "ACTIVE", revokedAt: options.revoked ? new Date() : null };
    } },
    subscription: { async findUnique() {
      read("subscription.findUnique");
      return { status: "ACTIVE", plan: { active: true, features: [{ configuration }] } };
    } },
    merchantKnowledgeSource: {
      async findMany() {
        read("merchantKnowledgeSource.findMany");
        return [{ id: sourceId, position: 0,
          purpose: { key: "PRODUCT_INFORMATION", active: true },
          dataFormat: { key: "XLSX", active: true } }];
      },
      async findFirst() {
        read("merchantKnowledgeSource.findFirst");
        return { id: sourceId, purposeId: "purpose-one", dataFormatId: "format-one", currentGeneration: generation,
          purpose: { key: "PRODUCT_INFORMATION" }, dataFormat: { key: "XLSX", inputKind: "UPLOAD" } };
      },
    },
    merchantKnowledgePurposeDataFormat: { async findFirst() {
      read("merchantKnowledgePurposeDataFormat.findFirst");
      return { purposeId: "purpose-one", dataFormatId: "format-one",
        dataFormat: { key: "XLSX", active: true, canonicalExtension: ".xlsx",
          acceptedContentTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] } };
    } },
    merchantKnowledgeSourceRevision: { async findUnique() {
      read("merchantKnowledgeSourceRevision.findUnique");
      const result = { uploadedAsset: { id: assetId, shopId: principal.shopId,
        status: "AVAILABLE", dataFormatId: "format-one" } };
      if (options.simultaneousReaders) {
        waiting++;
        if (waiting === options.simultaneousReaders) releaseReaders();
        await readerGate;
      }
      return result;
    } },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      operations.push("transaction.begin");
      const originalGeneration = generation;
      try {
        const result = await callback({
          merchantKnowledgeSource: { async updateMany(args: {
            where: { id: string; shopId: string; currentGeneration: number; purposeId: string; dataFormatId: string };
            data: { currentGeneration: number };
          }) {
            operations.push("transaction.updateMany");
            if (args.where.id !== sourceId || args.where.shopId !== principal.shopId ||
              args.where.currentGeneration !== generation || args.where.purposeId !== "purpose-one" ||
              args.where.dataFormatId !== "format-one") return { count: 0 };
            generation = args.data.currentGeneration;
            return { count: 1 };
          } },
          merchantKnowledgeSourceRevision: { async create(args: { data: {
            sourceId: string; generation: number; reason: string; uploadedAssetId: string;
          } }) {
            operations.push("transaction.revision.create");
            if (options.failRevisionInsert) throw Error("revision insertion failed");
            revisions.push({ sourceId: args.data.sourceId, generation: args.data.generation,
              reason: args.data.reason, uploadedAssetId: args.data.uploadedAssetId });
            return { id: "revision-two" };
          } },
        });
        operations.push("transaction.commit");
        return result;
      } catch (error) {
        generation = originalGeneration;
        operations.push("transaction.rollback");
        throw error;
      }
    },
  };
  return { service: new MerchantKnowledgeUploadService(database as never), operations, revisions,
    get generation() { return generation; } };
}

test("reprocess validates before its two-write transaction", async () => {
  const state = fixture();
  const result = await state.service.reprocess(principal, sourceId);
  assert.deepEqual(result, { schemaVersion: 1, sourceId, revisionId: "revision-two", generation: 2, status: "ACCEPTED" });
  assert.equal(state.generation, 2);
  assert.deepEqual(state.revisions, [{ sourceId, generation: 2, reason: "REPROCESS", uploadedAssetId: assetId }]);
  assert.deepEqual(state.operations.slice(-4), ["transaction.begin", "transaction.updateMany",
    "transaction.revision.create", "transaction.commit"]);
  assert.ok(state.operations.slice(0, -4).every((operation) => !operation.startsWith("transaction.")));
});

test("two reprocess attempts with the same source generation cannot both write", async () => {
  const state = fixture({ simultaneousReaders: 2 });
  const outcomes = await Promise.allSettled([
    state.service.reprocess(principal, sourceId), state.service.reprocess(principal, sourceId),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.equal(rejected?.status, "rejected");
  if (rejected?.status === "rejected") {
    assert.ok(rejected.reason instanceof KnowledgeUploadError);
    assert.equal(rejected.reason.status, 409);
  }
  assert.equal(state.generation, 2);
  assert.equal(state.revisions.length, 1);
});

test("revision-insert failure rolls back the generation advance", async () => {
  const state = fixture({ failRevisionInsert: true });
  await assert.rejects(() => state.service.reprocess(principal, sourceId), /revision insertion failed/);
  assert.equal(state.generation, 1);
  assert.equal(state.revisions.length, 0);
  assert.equal(state.operations.at(-1), "transaction.rollback");
});

test("revoked WooCommerce connection is denied before starting a transaction", async () => {
  const state = fixture({ revoked: true });
  await assert.rejects(() => state.service.reprocess(principal, sourceId),
    (error: unknown) => error instanceof KnowledgeUploadError && error.status === 403);
  assert.ok(!state.operations.some((operation) => operation.startsWith("transaction.")));
});
