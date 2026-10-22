import assert from "node:assert/strict";
import test from "node:test";
import { MerchantKnowledgeUploadService } from "../../../../src/merchant/merchant-knowledge/upload.service.js";
import type { KnowledgeTimings } from "../../../../src/merchant/merchant-knowledge/timing.js";

const principal = { shopId: "shop-a", installationId: "install-a", canonicalSiteUrl: "https://woo.example.test",
  credentialVersion: 3 };
const upload = { idempotencyKey: "550e8400-e29b-41d4-a716-446655440000", purposeKey: "PRODUCT_INFORMATION",
  dataFormatKey: "CSV", originalFileName: "products.csv", contentType: "text/csv",
  sizeBytes: 20, sha256: "a".repeat(64) };
const featureConfig = { schemaVersion: 1, maxKnowledgeSources: 10, maxContentUnitsPerSource: 1500,
  allowedSourceTypes: [{ purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "CSV" }] };

function fixture(verificationFails = false) {
  let asset: Record<string, unknown> | null = null;
  let queries = 0;
  let verificationCalls = 0;
  let committed = false;
  const tx = {
    async $queryRaw() {
      return ++queries % 2
        ? [{ id: principal.shopId, domain: principal.canonicalSiteUrl, platform: "WOOCOMMERCE",
          shopifyShopId: null, status: "ACTIVE" }]
        : [{ id: principal.installationId, shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
          credentialVersion: principal.credentialVersion, status: "ACTIVE", revokedAt: null }];
    },
    subscription: { async findUnique() { return { status: "ACTIVE", plan: { active: true,
      features: [{ configuration: featureConfig }] } }; } },
    merchantKnowledgePurposeDataFormat: { async findFirst() { return {
      purposeId: "purpose", dataFormatId: "format", dataFormat: { key: "CSV", active: true,
        canonicalExtension: ".csv", acceptedContentTypes: ["text/csv"] },
    }; } },
    merchantKnowledgeUploadedAsset: {
      async findUnique() { return asset; },
      async findFirst() { return asset && { ...asset, dataFormat: { key: "CSV", inputKind: "UPLOAD" } }; },
      async count() { return 0; },
      async create({ data }: { data: Record<string, unknown> }) { asset = data; return data; },
      async update() { committed = true; return asset; },
    },
    merchantKnowledgeSource: {
      async findMany() { return []; },
      async create() { return { id: "source" }; },
    },
    merchantKnowledgeSourceRevision: { async create() { return { id: "revision" }; } },
  };
  const database = { async $transaction<T>(action: (client: typeof tx) => Promise<T>) { return action(tx); } };
  const service = new MerchantKnowledgeUploadService(database as never, {
    environment: "test", now: () => new Date("2026-10-20T12:00:00Z"),
    config: { endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "bucket",
      accessKeyId: "credential", secretAccessKey: "never-log", maxUploadBytes: 1024 },
    r2: {
      async sign() { return "https://signed.example.test/?X-Amz-Signature=never-log"; },
      async verify() { verificationCalls++; if (verificationFails) throw new Error("private provider credentials"); },
    },
  });
  return { service, committed: () => committed, verificationCalls: () => verificationCalls };
}

function assertPhases(timings: KnowledgeTimings, phases: readonly (keyof KnowledgeTimings)[]) {
  for (const phase of phases) {
    assert.equal(typeof timings[phase], "number", phase);
    assert.ok(Number.isFinite(timings[phase]), phase);
    assert.ok(timings[phase]! >= 0, phase);
  }
  assert.deepEqual(Object.keys(timings).sort(), [...phases].sort(), "only approved timing keys are recorded");
}

test("intent measures configuration, transaction and signing without altering the upload capability", async () => {
  const { service } = fixture();
  const timings: KnowledgeTimings = {};
  const result = await service.intent(principal, upload, timings);
  assert.equal(result.schemaVersion, 1);
  assert.ok(result.uploadUrl.includes("X-Amz-Signature="));
  assertPhases(timings, ["configurationMs", "intentTransactionMs", "signingMs"]);
  assert.equal(JSON.stringify(timings).includes("never-log"), false);
});

test("finalise measures both transactions and R2 verification, including a rejected verification", async () => {
  const good = fixture();
  const intent = await good.service.intent(principal, upload);
  const finalize = { assetId: intent.assetId, purposeKey: upload.purposeKey,
    name: "Products", languageTag: "en", contentType: upload.contentType,
    sizeBytes: upload.sizeBytes, sha256: upload.sha256 };
  const timings: KnowledgeTimings = {};
  const result = await good.service.finalize(principal, finalize, timings);
  assert.equal(result.status, "ACCEPTED");
  assert.equal(good.committed(), true);
  assert.equal(good.verificationCalls(), 1);
  assertPhases(timings, ["configurationMs", "preliminaryTransactionMs", "r2VerificationMs", "commitTransactionMs"]);

  const bad = fixture(true);
  const second = await bad.service.intent(principal, upload);
  const failedTimings: KnowledgeTimings = {};
  await assert.rejects(() => bad.service.finalize(principal, { ...finalize, assetId: second.assetId }, failedTimings),
    /private provider credentials/);
  assert.equal(bad.committed(), false);
  assertPhases(failedTimings, ["configurationMs", "preliminaryTransactionMs", "r2VerificationMs"]);
  assert.equal(JSON.stringify(failedTimings).includes("private"), false);
});
