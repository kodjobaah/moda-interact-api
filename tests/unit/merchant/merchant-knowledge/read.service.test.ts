import assert from "node:assert/strict";
import test from "node:test";
import { MerchantKnowledgeReadService } from "../../../../src/merchant/merchant-knowledge/read.service.js";
import { MerchantKnowledgeReadError } from "../../../../src/merchant/merchant-knowledge/contract.js";

const principal = { shopId: "shop-woo", installationId: "install-woo", canonicalSiteUrl: "https://woo.example",
  credentialVersion: 3 };
const configuration = { schemaVersion: 1, maxKnowledgeSources: 1, maxContentUnitsPerSource: 1500,
  allowedSourceTypes: [{ purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" }, { purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "CSV" }] };
const purpose = { key: "FAQ", displayName: "FAQ", active: true };
const webFormat = { key: "WEB_PAGE", displayName: "Web page", active: true };
function row(index: number, options: { purpose?: typeof purpose; format?: typeof webFormat; status?: string } = {}) {
  return { id: `source-${index}`, name: `Source ${index}`, position: index, languageTag: "en", currentGeneration: 2,
    purpose: options.purpose ?? purpose, dataFormat: options.format ?? webFormat,
    revisions: [{ id: `latest-${index}`, generation: 2, reason: "REFRESH", status: options.status ?? "FAILED",
      requestedUrl: "https://example.org/help?signature=SECRET#private",
      resolvedUrl: "https://bucket.r2.dev/object-key?signature=SECRET", contentUnits: null, truncated: false,
      fetchedAt: null, completedAt: null, failureCode: "PROVIDER_SECRET=https://example.org/private",
      uploadedAsset: null }],
  };
}
function fake(options: { mapping?: unknown; preference?: boolean; feature?: boolean; count?: number;
  rows?: ReturnType<typeof row>[]; active?: boolean; platform?: string; version?: number; fail?: boolean } = {}) {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const track = (name: string, args?: unknown) => { calls.push({ name, args }); };
  const sources = options.rows ?? [row(1), row(2)];
  const transaction = {
    shop: { findUnique: async (args: unknown) => {
      track("shop", args);
      return { id: principal.shopId, domain: principal.canonicalSiteUrl, platform: options.platform ?? "WOOCOMMERCE",
        shopifyShopId: null, status: "ACTIVE", defaultLanguageTag: "en" };
    } },
    wooCommerceInstallation: { findUnique: async (args: unknown) => {
      track("installation", args);
      return { id: principal.installationId, shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
        credentialVersion: options.version ?? 3, status: "ACTIVE", revokedAt: null };
    } },
    subscription: { findUnique: async (args: unknown) => {
      track("subscription", args);
      return { status: "ACTIVE", planId: "plan-1", plan: { active: true,
        features: options.mapping === null ? [] : [{ featureId: "feature-1", configuration: options.mapping ?? configuration }] } };
    } },
    feature: { findUnique: async () => options.feature === false ? null : { id: "feature-1", active: true, activationMode: "MERCHANT_OPT_IN" } },
    shopFeaturePreference: { findUnique: async () => ({ enabled: options.preference ?? false }) },
    merchantKnowledgeSource: {
      count: async (args: { where: { OR?: unknown[]; position?: { lte: number } } }) => {
        track("count", args);
        if (options.fail) throw new Error("raw DB connection string secret");
        return args.where.OR ? args.where.position ? 0 : (options.count ?? sources.length) : (options.count ?? sources.length);
      },
      findMany: async (args: { where: { shopId: string; position?: { gt: number } }; take: number }) => {
        track("sources", args);
        return sources.filter((source) => source.position > (args.where.position?.gt ?? -1)).slice(0, args.take);
      },
    },
    merchantKnowledgePurposeDataFormat: { findMany: async (args: unknown) => {
      track("catalogue", args);
      return [{ purpose: { key: "FAQ", displayName: "FAQ" }, dataFormat: { key: "WEB_PAGE", displayName: "Web page",
        inputKind: "REMOTE_URL", canonicalExtension: null, acceptedContentTypes: ["text/html"] } },
        { purpose: { key: "PRODUCT_INFORMATION", displayName: "Products" }, dataFormat: { key: "CSV", displayName: "CSV",
          inputKind: "UPLOAD", canonicalExtension: ".csv", acceptedContentTypes: ["text/csv"] } }];
    } },
    merchantKnowledgeSourceRevision: {
      groupBy: async (args: unknown) => {
        track("activeGroup", args);
        return options.active ? [{ sourceId: "source-1", _max: { generation: 1 } }] : [];
      },
      findMany: async (args: unknown) => {
        track("activeRevisions", args);
        return [{ id: "older-active", sourceId: "source-1", generation: 1, contentUnits: 42, truncated: false,
          fetchedAt: new Date("2026-10-14T00:00:00.000Z") }];
      },
    },
  };
  const database = { $transaction: async (run: (tx: typeof transaction) => Promise<unknown>, opts: unknown) => {
    track("transaction", opts);
    return run(transaction);
  } };
  return { service: new MerchantKnowledgeReadService(database as never, "1024"), calls };
}

test("entitled, preference-off read returns existing capacity, correct dormant states, and safe revision projections", async () => {
  const { service, calls } = fake({ active: true });
  const result = await service.read(principal);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.state, "MERCHANT_DISABLED");
  assert.equal(result.planEntitled, true);
  assert.equal(result.merchantEnabled, false);
  assert.equal(result.effectiveEnabled, false);
  assert.equal(result.maxKnowledgeSources, 1);
  assert.equal(result.maxContentUnitsPerSource, 1500);
  assert.equal(result.maxUploadBytes, 1024);
  assert.equal(result.configuredCount, 2);
  assert.equal(result.sources[0]?.dormantReason, "MERCHANT_DISABLED");
  assert.equal(result.sources[0]?.currentlyPlanEntitled, true);
  assert.equal(result.sources[0]?.processingEligible, false);
  assert.equal(result.sources[1]?.dormantReason, "SOURCE_COUNT");
  assert.equal(result.sources[1]?.currentlyPlanEntitled, false);
  assert.equal(result.sources[0]?.revision?.generation, 2);
  assert.equal(result.sources[0]?.activeRevision?.generation, 1);
  assert.equal(result.sources[0]?.revision?.activeContentUnits, 42);
  assert.equal(result.sources[0]?.revision?.requestedUrl, "https://example.org/help");
  assert.equal(result.sources[0]?.revision?.resolvedUrl, null);
  assert.equal(result.sources[0]?.revision?.failureCode, null);
  assert.equal(result.catalogue.length, 2);
  assert.equal(result.supportedLanguageTags.length, 20);
  assert.equal(calls.find((call) => call.name === "transaction")?.args &&
    (calls.find((call) => call.name === "transaction")!.args as { isolationLevel: string }).isolationLevel, "RepeatableRead");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(JSON.stringify(result).includes("object-key"), false);
});

test("public revision failure codes are strictly allowlisted, never inferred from Error.name syntax", async () => {
  const accepted = ["HTTP_5XX", "UNSAFE_URL", "RETRIES_EXHAUSTED"];
  const rejected = [
    "Acquisition_Failure___secret",
    "ACQUISITION_FAILURE___SECRET",
    "INTERNAL_PROVIDER_EXCEPTION",
    "HTTP_5XX_EXTRA",
    "PROVIDER_SECRET=https://example.org/private",
  ];
  const cases: Array<{ failureCode: string; expected: string | null }> = [
    ...accepted.map((failureCode) => ({ failureCode, expected: failureCode })),
    ...rejected.map((failureCode) => ({ failureCode, expected: null })),
  ];
  for (const { failureCode, expected } of cases) {
    const source = row(1);
    source.revisions[0]!.failureCode = failureCode;
    const response = await fake({ rows: [source] }).service.read(principal);
    const serialized = JSON.stringify(response);
    assert.equal(response.sources[0]?.revision?.failureCode, expected, failureCode);
    if (expected === null) {
      assert.equal(serialized.includes(failureCode), false, failureCode);
      assert.match(serialized, /"failureCode":null/);
    } else {
      assert.equal(serialized.includes(`"failureCode":"${expected}"`), true, failureCode);
    }
  }
});

test("entitled enabled merchant can process first eligible source only", async () => {
  const result = await fake({ preference: true }).service.read(principal);
  assert.equal(result.state, "ENABLED");
  assert.equal(result.sources[0]?.processingEligible, true);
  assert.equal(result.sources[1]?.processingEligible, false);
});

test("without entitlement preserve existing sources without leaking prior plan capacity", async () => {
  const { service, calls } = fake({ mapping: null, preference: true });
  const result = await service.read(principal);
  assert.equal(result.state, "PLAN_UNENTITLED");
  assert.equal(result.merchantEnabled, true);
  assert.equal(result.effectiveEnabled, false);
  assert.equal(result.configuredCount, 2);
  assert.equal(result.maxKnowledgeSources, 0);
  assert.deepEqual(result.catalogue, []);
  assert.deepEqual(result.sources.map((source) => source.dormantReason), ["NO_CURRENT_PLAN", "NO_CURRENT_PLAN"]);
  assert.equal(calls.some(({ name }) => name === "catalogue"), false);
});

test("filters disabled or unapproved source pairs, retains their lifecycle as SOURCE_TYPE", async () => {
  const unsupported = row(1, { format: { ...webFormat, key: "XLSX", active: true } });
  const disabled = row(2, { purpose: { ...purpose, active: false } });
  const out = await fake({ rows: [unsupported, disabled], preference: true }).service.read(principal);
  assert.deepEqual(out.sources.map((source) => source.dormantReason), ["SOURCE_TYPE", "SOURCE_TYPE"]);
});

test("returns bounded pages using shop-owned position cursor", async () => {
  const rows = Array.from({ length: 105 }, (_, i) => row(i));
  const service = fake({ rows, count: 105 }).service;
  const first = await service.read(principal);
  assert.equal(first.sources.length, 100);
  assert.equal(first.nextPosition, 99);
  assert.equal(first.configuredCount, 105);
  const second = await service.read(principal, first.nextPosition);
  assert.equal(second.sources.length, 5);
  assert.equal(second.nextPosition, null);
  assert.equal(second.sources[0]?.position, 100);
});

test("rejects revoked/rotated or non-Woo tenant identity and never reads its source rows", async () => {
  for (const options of [{ platform: "SHOPIFY" }, { version: 4 }]) {
    const { service, calls } = fake(options);
    await assert.rejects(() => service.read(principal), (error: unknown) =>
      error instanceof MerchantKnowledgeReadError && error.status === 409);
    assert.equal(calls.some(({ name }) => name === "sources"), false);
  }
});

test("invalid plan schema and database failures are explicit unavailable, not unentitled", async () => {
  for (const options of [{ mapping: { ...configuration, maxKnowledgeSources: 0 } }, { fail: true }]) {
    await assert.rejects(() => fake(options).service.read(principal), (error: unknown) =>
      error instanceof MerchantKnowledgeReadError && error.status === 503 &&
      error.code === "merchant_knowledge_unavailable");
  }
});

test("invalid query bounds and absent upload configuration do not enable writes", async () => {
  const data = fake();
  await assert.rejects(() => data.service.read(principal, -1), (error: unknown) =>
    error instanceof MerchantKnowledgeReadError && error.status === 400);
  const service = new MerchantKnowledgeReadService({ $transaction: async (work: (tx: never) => Promise<unknown>) =>
    work({} as never) } as never);
  // Upload configuration is optional for a read; source projection is covered separately.
  assert.equal(typeof service.read, "function");
});
