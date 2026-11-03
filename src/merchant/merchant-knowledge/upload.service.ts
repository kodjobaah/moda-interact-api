import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { MerchantKnowledgeFeatureConfigurationSchema } from "@modainteract/moda-interact-shared/merchant-knowledge";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { conflict, denied, deterministicAssetId, integrity, invalid, isWooObjectKeyForAsset, KnowledgeUploadError,
  type UploadFinalizeRequest, type UploadIntentRequest, UPLOAD_TTL_SECONDS, unavailable, wooObjectKey } from "./upload-contract.js";
import { createUploadR2, type UploadR2, type UploadR2Configuration } from "./upload-r2.js";
import type { ApiPlatformConfigurationReader } from "../../platform-configuration/service.js";
import { assertWooPrincipal } from "./read.service.js";
import { MerchantKnowledgeReadError } from "./contract.js";
import { timeKnowledgePhase, type KnowledgeTimings } from "./timing.js";

type Tx = Prisma.TransactionClient;
const nowDate = () => new Date();

async function assertWoo(tx: Tx, principal: WooInstallationPrincipal): Promise<string> {
  const shops = await tx.$queryRaw<Array<{ id: string; domain: string; platform: string; shopifyShopId: string | null; status: string }>>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `);
  const shop = shops[0];
  if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
    shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE") throw denied();
  const installations = await tx.$queryRaw<Array<{ id: string; shopId: string; canonicalSiteUrl: string; status: string; revokedAt: Date | null; credentialVersion: number }>>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "status", "revokedAt", "credentialVersion"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId} FOR SHARE
  `);
  const installation = installations[0];
  if (!installation || installation.id !== principal.installationId || installation.shopId !== principal.shopId ||
      installation.canonicalSiteUrl !== principal.canonicalSiteUrl || installation.credentialVersion !== principal.credentialVersion ||
      installation.status !== "ACTIVE" || installation.revokedAt !== null) throw denied();
  return shop.domain;
}

async function entitlement(tx: Tx, shopId: string) {
  const subscription = await tx.subscription.findUnique({ where: { shopId },
    select: { status: true, plan: { select: { active: true, features: { where: {
      enabled: true, feature: { is: { key: "merchant_knowledge", active: true, activationMode: "MERCHANT_OPT_IN" } },
    }, select: { configuration: true } } } } } });
  if (!subscription || !["ACTIVE", "TRIALING"].includes(subscription.status) || !subscription.plan?.active) throw denied();
  if (subscription.plan.features.length !== 1) {
    if (!subscription.plan.features.length) throw denied();
    throw unavailable();
  }
  const parsed = MerchantKnowledgeFeatureConfigurationSchema.safeParse(subscription.plan.features[0]!.configuration);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

async function allowedPair(tx: Tx, config: Awaited<ReturnType<typeof entitlement>>, purposeKey: string, formatKey: string) {
  if (!config.allowedSourceTypes.some((pair) => pair.purposeKey === purposeKey && pair.dataFormatKey === formatKey)) throw denied();
  const pair = await tx.merchantKnowledgePurposeDataFormat.findFirst({ where: {
    purpose: { key: purposeKey, active: true },
    dataFormat: { key: formatKey, active: true, inputKind: "UPLOAD" },
  }, select: { purposeId: true, dataFormatId: true, dataFormat: { select: {
    key: true, active: true, canonicalExtension: true, acceptedContentTypes: true,
  } } } });
  if (!pair) throw denied();
  const suffix = `.${formatKey.toLowerCase()}`;
  if (pair.dataFormat.canonicalExtension?.toLowerCase() !== suffix) throw unavailable();
  const contentTypes = pair.dataFormat.acceptedContentTypes;
  if (!Array.isArray(contentTypes) || !contentTypes.every((value) => typeof value === "string")) throw unavailable();
  return { ...pair, contentTypes: contentTypes as string[] };
}

function allowedSourceWhere(shopId: string, config: Awaited<ReturnType<typeof entitlement>>) {
  return { shopId, OR: config.allowedSourceTypes.map(({ purposeKey, dataFormatKey }) => ({
    purpose: { is: { key: purposeKey, active: true } },
    dataFormat: { is: { key: dataFormatKey, active: true } },
  })) };
}

async function eligibleSource(tx: Tx, shopId: string, sourceId: string, config: Awaited<ReturnType<typeof entitlement>>) {
  if (config.allowedSourceTypes.length === 0 || config.maxKnowledgeSources === 0) throw denied();
  const candidates = await tx.merchantKnowledgeSource.findMany({ where: allowedSourceWhere(shopId, config),
    orderBy: [{ position: "asc" }, { id: "asc" }], take: config.maxKnowledgeSources,
    select: { id: true, position: true, purposeId: true, dataFormatId: true, currentGeneration: true,
      name: true, languageTag: true,
      purpose: { select: { key: true } }, dataFormat: { select: { key: true, inputKind: true } } } });
  const source = candidates.find((candidate) => candidate.id === sourceId);
  if (!source || source.dataFormat.inputKind !== "UPLOAD") throw denied();
  return source;
}

async function originalIntakeReplay(tx: Tx, assetId: string, shopId: string, purposeKey: string,
  dataFormatId: string, sourceId?: string) {
  const rows = await tx.merchantKnowledgeSourceRevision.findMany({ where: {
    uploadedAssetId: assetId, reason: { in: ["CREATE", "FILE_REPLACE"] },
  }, take: 2, select: { id: true, sourceId: true, generation: true, reason: true,
    source: { select: { shopId: true, purpose: { select: { key: true } }, dataFormatId: true } } } });
  if (rows.length !== 1) throw conflict();
  const revision = rows[0]!;
  if (revision.source.shopId !== shopId || revision.source.purpose.key !== purposeKey || revision.source.dataFormatId !== dataFormatId ||
      (sourceId !== undefined && sourceId !== revision.sourceId)) throw conflict();
  return { revisionId: revision.id, sourceId: revision.sourceId, generation: revision.generation };
}

async function sourcePositions(tx: Tx, shopId: string) {
  return tx.merchantKnowledgeSource.findMany({ where: { shopId }, orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, position: true } });
}

async function eligibleSourceCount(tx: Tx, shopId: string, config: Awaited<ReturnType<typeof entitlement>>) {
  if (config.allowedSourceTypes.length === 0) return 0;
  return tx.merchantKnowledgeSource.count({ where: allowedSourceWhere(shopId, config) });
}

export interface UploadServiceOptions {
  r2?: UploadR2;
  config?: UploadR2Configuration;
  environment?: string;
  configuration?: Pick<ApiPlatformConfigurationReader, "requireMerchantKnowledgeR2Configuration">;
  now?: () => Date;
}
export class MerchantKnowledgeUploadService {
  constructor(private readonly database: PrismaClient,
    private readonly options: UploadServiceOptions = {}) {}
  private async dependencies() {
    // A single decrypted purpose-scoped snapshot is used by each upload operation.
    // Injected fixtures remain available for isolated tests, not production composition.
    let config: UploadR2Configuration;
    try {
      if (this.options.configuration) {
        const snapshot = await this.options.configuration.requireMerchantKnowledgeR2Configuration();
        config = { endpoint: snapshot.r2Endpoint, bucket: snapshot.r2Bucket,
          accessKeyId: snapshot.r2AccessKeyId, secretAccessKey: snapshot.r2SecretAccessKey,
          maxUploadBytes: snapshot.maxUploadBytes };
      } else if (this.options.config) config = this.options.config;
      else throw unavailable();
    } catch (error) { throw unavailable(error); }
    let r2: UploadR2;
    try { r2 = this.options.r2 ?? createUploadR2(config); }
    catch (error) { throw unavailable(error); }
    const environment = this.options.environment ?? process.env.NODE_ENV ?? "development";
    return { config, r2, environment };
  }
  private now() { return this.options.now?.() ?? nowDate(); }

  async intent(principal: WooInstallationPrincipal, request: UploadIntentRequest, timings?: KnowledgeTimings) {
    const { config, r2, environment } = await timeKnowledgePhase(timings, "configurationMs", () => this.dependencies());
    if (request.sizeBytes > config.maxUploadBytes) throw new KnowledgeUploadError(413, "request_too_large");
    const assetId = deterministicAssetId(principal.shopId, request.idempotencyKey);
    const prepared = await timeKnowledgePhase(timings, "intentTransactionMs", () => this.database.$transaction(async (tx) => {
      // The storage hostname is taken only from the validated Shop record.
      const shopDomain = await assertWoo(tx, principal);
      const entitlementConfig = await entitlement(tx, principal.shopId);
      const pair = await allowedPair(tx, entitlementConfig, request.purposeKey, request.dataFormatKey);
      if (!pair.contentTypes.some((value) => value.toLowerCase() === request.contentType)) throw invalid();
      const existing = await tx.merchantKnowledgeUploadedAsset.findUnique({ where: { id: assetId } });
      if (existing) {
        // Retries must sign the EXACT persisted key, including legacy API-017
        // keys and intents created before a site's canonical domain changed.
        if (existing.shopId !== principal.shopId ||
          !isWooObjectKeyForAsset(existing.objectKey, environment, principal.shopId, assetId, request.dataFormatKey) ||
          existing.status !== "PENDING_UPLOAD" || existing.dataFormatId !== pair.dataFormatId ||
          existing.intentPurposeKey !== request.purposeKey ||
          existing.originalFileName !== request.originalFileName || existing.contentType !== request.contentType ||
          existing.sizeBytes !== BigInt(request.sizeBytes) || existing.sha256 !== request.sha256) throw conflict();
        if (existing.uploadExpiresAt <= this.now()) throw new KnowledgeUploadError(409, "knowledge_upload_expired");
        return { expiresAt: existing.uploadExpiresAt, objectKey: existing.objectKey };
      }
      const outstanding = await tx.merchantKnowledgeUploadedAsset.count({ where: {
        shopId: principal.shopId, status: "PENDING_UPLOAD", uploadExpiresAt: { gt: this.now() },
      } });
      if (outstanding >= Math.max(3, entitlementConfig.maxKnowledgeSources * 3)) throw denied();
      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + UPLOAD_TTL_SECONDS * 1000);
      const objectKey = wooObjectKey(environment, principal.shopId, shopDomain, assetId, request.dataFormatKey, createdAt);
      await tx.merchantKnowledgeUploadedAsset.create({ data: { id: assetId, shopId: principal.shopId,
        dataFormatId: pair.dataFormatId, intentPurposeKey: request.purposeKey, status: "PENDING_UPLOAD", objectKey,
        originalFileName: request.originalFileName, contentType: request.contentType,
        sizeBytes: BigInt(request.sizeBytes), sha256: request.sha256, uploadExpiresAt: expiresAt } });
      return { expiresAt, objectKey };
    }));
    // No external R2 operation inside the database transaction. Retrying uses the same immutable intent.
    const secondsLeft = Math.floor((prepared.expiresAt.getTime() - this.now().getTime()) / 1000);
    if (secondsLeft < 1) throw new KnowledgeUploadError(409, "knowledge_upload_expired");
    const signed = await timeKnowledgePhase(timings, "signingMs", () => r2.sign({
      key: prepared.objectKey, contentType: request.contentType,
      sha256: request.sha256, expiresIn: Math.min(UPLOAD_TTL_SECONDS, secondsLeft),
    }));
    return { schemaVersion: 1 as const, assetId, uploadUrl: signed,
      expiresAt: prepared.expiresAt.toISOString(), maxUploadBytes: config.maxUploadBytes,
      requiredHeaders: { "Content-Type": request.contentType, "If-None-Match": "*",
        "x-amz-meta-sha256": request.sha256 } };
  }

  async finalize(principal: WooInstallationPrincipal, request: UploadFinalizeRequest, timings?: KnowledgeTimings) {
    const { config, r2 } = await timeKnowledgePhase(timings, "configurationMs", () => this.dependencies());
    if (request.sizeBytes > config.maxUploadBytes) throw integrity();
    const preliminary = await timeKnowledgePhase(timings, "preliminaryTransactionMs", () => this.database.$transaction(async (tx) => {
      await assertWoo(tx, principal);
      const asset = await tx.merchantKnowledgeUploadedAsset.findFirst({ where: { id: request.assetId, shopId: principal.shopId },
        select: { id: true, status: true, shopId: true, objectKey: true, uploadExpiresAt: true,
          dataFormatId: true, contentType: true, sizeBytes: true, sha256: true,
          intentPurposeKey: true,
          dataFormat: { select: { key: true, inputKind: true } } } });
      if (!asset) throw new KnowledgeUploadError(404, "knowledge_upload_not_found");
      if (asset.dataFormat.inputKind !== "UPLOAD" || !["CSV", "XLSX"].includes(asset.dataFormat.key) ||
          asset.contentType !== request.contentType || asset.sizeBytes !== BigInt(request.sizeBytes) ||
          asset.sha256 !== request.sha256) throw integrity();
      const configCurrent = await entitlement(tx, principal.shopId);
      const pair = await allowedPair(tx, configCurrent, request.purposeKey, asset.dataFormat.key);
      if (pair.dataFormatId !== asset.dataFormatId || !pair.contentTypes.some((value) => value.toLowerCase() === request.contentType)) throw denied();
      if (asset.status === "AVAILABLE") {
        const replay = await originalIntakeReplay(tx, asset.id, principal.shopId, request.purposeKey, asset.dataFormatId, request.sourceId);
        if (asset.intentPurposeKey !== null && asset.intentPurposeKey !== request.purposeKey) throw conflict();
        return { completed: true as const, ...replay };
      }
      if (asset.status !== "PENDING_UPLOAD") throw conflict();
      if (asset.intentPurposeKey !== request.purposeKey) throw conflict();
      if (asset.uploadExpiresAt <= this.now()) throw new KnowledgeUploadError(409, "knowledge_upload_expired");
      let expectedGeneration: number | undefined;
      if (request.sourceId) {
        const source = await eligibleSource(tx, principal.shopId, request.sourceId, configCurrent);
        if (source.purposeId !== pair.purposeId || source.dataFormatId !== pair.dataFormatId) throw denied();
        expectedGeneration = source.currentGeneration;
      }
      return { completed: false as const, objectKey: asset.objectKey, expectedGeneration };
    }));
    if (preliminary.completed) return { schemaVersion: 1 as const, sourceId: preliminary.sourceId,
      revisionId: preliminary.revisionId, generation: preliminary.generation, status: "ACCEPTED" as const };
    // HEAD metadata is not proof of bytes. GET and bounded SHA-256 verification are mandatory.
    await timeKnowledgePhase(timings, "r2VerificationMs", () => r2.verify({
      key: preliminary.objectKey, contentType: request.contentType,
      sha256: request.sha256, sizeBytes: request.sizeBytes,
    }, timings));
    return timeKnowledgePhase(timings, "commitTransactionMs", () => this.database.$transaction(async (tx) => {
      await assertWoo(tx, principal);
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "commerce"."MerchantKnowledgeUploadedAsset"
        WHERE "id" = ${request.assetId} AND "shopId" = ${principal.shopId} FOR NO KEY UPDATE
      `);
      if (locked.length !== 1) throw denied();
      const asset = await tx.merchantKnowledgeUploadedAsset.findFirst({ where: { id: request.assetId, shopId: principal.shopId },
        include: { dataFormat: { select: { key: true, inputKind: true } } } });
      if (!asset) throw denied();
      const currentConfig = await entitlement(tx, principal.shopId);
      if (asset.dataFormat.inputKind !== "UPLOAD" || !["CSV", "XLSX"].includes(asset.dataFormat.key) ||
          asset.contentType !== request.contentType || asset.sizeBytes !== BigInt(request.sizeBytes) ||
          asset.sha256 !== request.sha256) throw integrity();
      const pair = await allowedPair(tx, currentConfig, request.purposeKey, asset.dataFormat.key);
      if (pair.dataFormatId !== asset.dataFormatId || !pair.contentTypes.some((value) => value.toLowerCase() === request.contentType)) throw denied();
      if (asset.intentPurposeKey !== null && asset.intentPurposeKey !== request.purposeKey) throw conflict();
      if (asset.status === "AVAILABLE") {
        const previous = await originalIntakeReplay(tx, asset.id, principal.shopId, request.purposeKey, asset.dataFormatId, request.sourceId);
        return { schemaVersion: 1 as const, ...previous, status: "ACCEPTED" as const };
      }
      if (asset.status !== "PENDING_UPLOAD") throw conflict();
      if (asset.uploadExpiresAt <= this.now()) throw new KnowledgeUploadError(409, "knowledge_upload_expired");
      if (asset.intentPurposeKey !== request.purposeKey) throw conflict();
      let sourceId = request.sourceId;
      let generation: number;
      let reason: "CREATE" | "FILE_REPLACE";
      if (sourceId) {
        const sourceLocks = await tx.$queryRaw<Array<{ id: string; currentGeneration: number }>>(Prisma.sql`
          SELECT "id", "currentGeneration" FROM "commerce"."MerchantKnowledgeSource"
          WHERE "id" = ${sourceId} AND "shopId" = ${principal.shopId} FOR UPDATE
        `);
        if (sourceLocks.length !== 1 || preliminary.expectedGeneration === undefined ||
            sourceLocks[0]!.currentGeneration !== preliminary.expectedGeneration) throw conflict();
        const existing = await eligibleSource(tx, principal.shopId, sourceId, currentConfig);
        if (existing.purposeId !== pair.purposeId || existing.dataFormatId !== pair.dataFormatId) throw denied();
        generation = existing.currentGeneration + 1;
        if (!Number.isSafeInteger(generation) || generation > 2147483647) throw conflict();
        reason = "FILE_REPLACE";
        await tx.merchantKnowledgeSource.update({ where: { id: sourceId }, data: {
          name: request.name, languageTag: request.languageTag, currentGeneration: generation,
        } });
      } else {
        const [rows, eligibleCount] = await Promise.all([
          sourcePositions(tx, principal.shopId), eligibleSourceCount(tx, principal.shopId, currentConfig),
        ]);
        if (eligibleCount >= currentConfig.maxKnowledgeSources) throw denied();
        const position = rows.reduce((highest, source) => Math.max(highest, source.position), -1) + 1;
        if (position > 2147483647) throw conflict();
        sourceId = randomUUID();
        generation = 1;
        reason = "CREATE";
        await tx.merchantKnowledgeSource.create({ data: { id: sourceId, shopId: principal.shopId,
          purposeId: pair.purposeId, dataFormatId: pair.dataFormatId, name: request.name,
          languageTag: request.languageTag, position, currentGeneration: generation } });
      }
      await tx.merchantKnowledgeUploadedAsset.update({ where: { id: asset.id }, data: {
        status: "AVAILABLE", availableAt: this.now(),
      } });
      const revision = await tx.merchantKnowledgeSourceRevision.create({ data: {
        sourceId, generation, reason, uploadedAssetId: asset.id, status: "PENDING", requestedAt: this.now(),
      }, select: { id: true } });
      return { schemaVersion: 1 as const, sourceId, revisionId: revision.id,
        generation, status: "ACCEPTED" as const };
    }, { timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }));
  }

  async edit(principal: WooInstallationPrincipal, sourceId: string, change: { name: string; languageTag: string }) {
    return this.database.$transaction(async (tx) => {
      await assertWoo(tx, principal);
      const configuration = await entitlement(tx, principal.shopId);
      const source = await eligibleSource(tx, principal.shopId, sourceId, configuration);
      await allowedPair(tx, configuration, source.purpose.key, source.dataFormat.key);
      const updated = source.name !== change.name || source.languageTag !== change.languageTag;
      if (updated) await tx.merchantKnowledgeSource.update({ where: { id: sourceId }, data: change });
      return { schemaVersion: 1 as const, sourceId, updated: true as const };
    });
  }

  async reprocess(principal: WooInstallationPrincipal, sourceId: string) {
    // Authentication, entitlement, catalogue and asset reads do not need a transaction.
    try { await assertWooPrincipal(this.database, principal); }
    catch (error) {
      if (error instanceof MerchantKnowledgeReadError) throw denied();
      throw error;
    }
    const configuration = await entitlement(this.database, principal.shopId);
    const source = await eligibleSource(this.database, principal.shopId, sourceId, configuration);
    await allowedPair(this.database, configuration, source.purpose.key, source.dataFormat.key);
    const previous = await this.database.merchantKnowledgeSourceRevision.findUnique({
      where: { sourceId_generation: { sourceId, generation: source.currentGeneration } },
      select: { uploadedAsset: { select: { id: true, shopId: true, status: true, dataFormatId: true } } },
    });
    const asset = previous?.uploadedAsset;
    if (!asset || asset.shopId !== principal.shopId || asset.status !== "AVAILABLE" ||
        asset.dataFormatId !== source.dataFormatId) throw denied();
    const generation = source.currentGeneration + 1;
    if (!Number.isSafeInteger(generation) || generation > 2147483647) throw conflict();

    return this.database.$transaction(async (tx) => {
      // Only the generation change and its revision insertion require atomicity.
      // The expected generation prevents concurrent writes from using a stale read.
      const updated = await tx.merchantKnowledgeSource.updateMany({ where: {
        id: sourceId, shopId: principal.shopId, currentGeneration: source.currentGeneration,
        purposeId: source.purposeId, dataFormatId: source.dataFormatId,
      }, data: { currentGeneration: generation } });
      if (updated.count !== 1) throw conflict();
      const revision = await tx.merchantKnowledgeSourceRevision.create({ data: { sourceId, generation,
        reason: "REPROCESS", status: "PENDING", uploadedAssetId: asset.id, requestedAt: this.now(),
      }, select: { id: true } });
      return { schemaVersion: 1 as const, sourceId, revisionId: revision.id, generation, status: "ACCEPTED" as const };
    });
  }
}

export function normaliseUploadError(error: unknown): KnowledgeUploadError {
  if (error instanceof KnowledgeUploadError) return error;
  // If the generated Prisma client has not exposed its runtime error constructor,
  // the normaliser must still return a bounded upload error for provider failures.
  const knownRequestError = Prisma.PrismaClientKnownRequestError;
  if (typeof knownRequestError === "function" && error instanceof knownRequestError &&
      ["P2002", "P2034"].includes(error.code)) return conflict();
  return unavailable(error);
}
