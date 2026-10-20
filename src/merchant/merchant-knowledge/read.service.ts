import type { Prisma } from "@prisma/client";
import { MerchantKnowledgeFeatureConfigurationSchema } from "@modainteract/moda-interact-shared/merchant-knowledge";
import { MODA_SUPPORTED_LANGUAGE_TAGS, resolveModaConfigurationLocale } from "@modainteract/moda-interact-shared/internationalization";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { MERCHANT_KNOWLEDGE_PAGE_SIZE, MerchantKnowledgeReadError, type MerchantKnowledgeReadResponse } from "./contract.js";
import { projectCatalogue, projectSource, type ActiveRevisionRow } from "./projection.js";
import type { ApiPlatformConfigurationReader } from "../../platform-configuration/service.js";

/** Read-only Prisma delegates supported by both the root client and a writer's transaction client. */
export type KnowledgeReadDatabase = Pick<Prisma.TransactionClient,
  "shop" | "wooCommerceInstallation" | "subscription" | "feature" | "shopFeaturePreference" |
  "merchantKnowledgeSource" | "merchantKnowledgePurposeDataFormat" | "merchantKnowledgeSourceRevision">;

export async function assertWooPrincipal(database: KnowledgeReadDatabase, principal: WooInstallationPrincipal): Promise<string | null> {
  const [shop, installation] = await Promise.all([
    database.shop.findUnique({
      where: { id: principal.shopId },
      select: { id: true, domain: true, platform: true, shopifyShopId: true, status: true, defaultLanguageTag: true },
    }),
    database.wooCommerceInstallation.findUnique({
      where: { id: principal.installationId },
      select: { id: true, shopId: true, canonicalSiteUrl: true, credentialVersion: true, status: true, revokedAt: true },
    }),
  ]);
  if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
    shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE" ||
    !installation || installation.id !== principal.installationId || installation.shopId !== principal.shopId ||
    installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
    installation.credentialVersion !== principal.credentialVersion ||
    installation.status !== "ACTIVE" || installation.revokedAt !== null) {
    throw new MerchantKnowledgeReadError(409, "merchant_knowledge_integrity_invalid");
  }
  return shop.defaultLanguageTag;
}

/** Only the accepted BillingPlan feature mapping grants capacity; a preference never creates entitlement. */
export async function readEntitlement(database: KnowledgeReadDatabase, shopId: string) {
  const [subscription, feature] = await Promise.all([
    database.subscription.findUnique({
      where: { shopId },
      select: {
        status: true, planId: true,
        plan: { select: {
          active: true,
          features: {
            where: { enabled: true, feature: { is: { key: "merchant_knowledge", active: true, activationMode: "MERCHANT_OPT_IN" } } },
            select: { configuration: true, featureId: true },
          },
        } },
      },
    }),
    database.feature.findUnique({
      where: { key: "merchant_knowledge" },
      select: { id: true, active: true, activationMode: true },
    }),
  ]);
  const activationEligible = Boolean(feature?.active && feature.activationMode === "MERCHANT_OPT_IN");
  const preference = activationEligible ? await database.shopFeaturePreference.findUnique({
    where: { shopId_featureId: { shopId, featureId: feature!.id } },
    select: { enabled: true },
  }) : null;
  const merchantEnabled = activationEligible && preference?.enabled === true;
  const eligibleSubscription = subscription && (subscription.status === "ACTIVE" || subscription.status === "TRIALING") &&
    subscription.planId && subscription.plan?.active;
  const features = eligibleSubscription ? subscription.plan!.features : [];
  if (features.length > 1) throw new MerchantKnowledgeReadError(503, "merchant_knowledge_unavailable");
  const mapping = features[0];
  if (mapping && (!feature || mapping.featureId !== feature.id)) {
    throw new MerchantKnowledgeReadError(503, "merchant_knowledge_unavailable");
  }
  if (!mapping) return { configuration: null, merchantEnabled };
  const configuration = MerchantKnowledgeFeatureConfigurationSchema.safeParse(mapping.configuration);
  if (!configuration.success) throw new MerchantKnowledgeReadError(503, "merchant_knowledge_unavailable");
  return { configuration: configuration.data, merchantEnabled };
}

function allowedSourceWhere(
  shopId: string,
  pairs: ReadonlyArray<{ purposeKey: string; dataFormatKey: string }>,
  position?: { lte: number },
) {
  return {
    shopId,
    ...(position ? { position } : {}),
    OR: pairs.map(({ purposeKey, dataFormatKey }) => ({
      purpose: { is: { key: purposeKey, active: true } },
      dataFormat: { is: { key: dataFormatKey, active: true } },
    })),
  };
}

function resolveUploadLimit(value: string | undefined): number {
  // An unconfigured upload service is not a reason to suppress read-only knowledge management.
  if (value === undefined || value === "") return 0;
  if (!/^[1-9]\d*$/.test(value)) throw new MerchantKnowledgeReadError(503, "merchant_knowledge_unavailable");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new MerchantKnowledgeReadError(503, "merchant_knowledge_unavailable");
  return number;
}

async function readActiveRevisions(database: KnowledgeReadDatabase, sourceIds: string[]): Promise<Map<string, ActiveRevisionRow>> {
  if (sourceIds.length === 0) return new Map();
  const grouped = await database.merchantKnowledgeSourceRevision.groupBy({
    by: ["sourceId"],
    where: { sourceId: { in: sourceIds }, status: "ACTIVE" },
    _max: { generation: true },
  });
  const identifiers = grouped.flatMap(({ sourceId, _max }) => _max.generation === null ? [] : [{ sourceId, generation: _max.generation }]);
  if (identifiers.length === 0) return new Map();
  const revisions = await database.merchantKnowledgeSourceRevision.findMany({
    where: { OR: identifiers, status: "ACTIVE" },
    select: { id: true, sourceId: true, generation: true, contentUnits: true, truncated: true, fetchedAt: true },
  });
  return new Map(revisions.map((revision) => [revision.sourceId, revision]));
}

/**
 * Best-effort read projection: no multi-statement transaction or connection pinning.
 * Writers independently enforce current entitlement and source generation under locks.
 */
export class MerchantKnowledgeReadService {
  constructor(
    private readonly database: KnowledgeReadDatabase,
    private readonly uploadLimitEnvironment: string | undefined = undefined,
    private readonly configuration?: Pick<ApiPlatformConfigurationReader, "readMerchantKnowledgeUploadPolicy">,
  ) {}

  async read(principal: WooInstallationPrincipal, afterPosition: number | null = null): Promise<MerchantKnowledgeReadResponse> {
    if (afterPosition !== null && (!Number.isSafeInteger(afterPosition) || afterPosition < 0 || afterPosition > 2147483647)) {
      throw new MerchantKnowledgeReadError(400, "invalid_request");
    }
    try {
      // Read configuration independently; no database transaction is required for a GET.
      const maxUploadBytes = this.configuration
        ? (await this.configuration.readMerchantKnowledgeUploadPolicy()).maxUploadBytes
        : resolveUploadLimit(this.uploadLimitEnvironment);
      const defaultLanguage = await assertWooPrincipal(this.database, principal);
      const [{ configuration, merchantEnabled }, allSourceCount] = await Promise.all([
        readEntitlement(this.database, principal.shopId),
        this.database.merchantKnowledgeSource.count({ where: { shopId: principal.shopId } }),
      ]);
      const planEntitled = configuration !== null;
      const allowed = configuration?.allowedSourceTypes ?? [];
      const allowedKeys = new Set(allowed.map(({ purposeKey, dataFormatKey }) => `${purposeKey}\u0000${dataFormatKey}`));
      const [catalogueRows, pageRows, planEligibleSourceCount, precedingEligibleCount] = await Promise.all([
        allowed.length ? this.database.merchantKnowledgePurposeDataFormat.findMany({
          where: {
            OR: allowed.map(({ purposeKey, dataFormatKey }) => ({ purpose: { is: { key: purposeKey } }, dataFormat: { is: { key: dataFormatKey } } })),
            purpose: { is: { active: true } },
            dataFormat: { is: { active: true, inputKind: { in: ["REMOTE_URL", "UPLOAD"] } } },
          },
          orderBy: [{ purpose: { displayOrder: "asc" } }, { purpose: { key: "asc" } },
            { dataFormat: { displayOrder: "asc" } }, { dataFormat: { key: "asc" } }],
          select: {
            purpose: { select: { key: true, displayName: true } },
            dataFormat: { select: { key: true, displayName: true, inputKind: true, canonicalExtension: true, acceptedContentTypes: true } },
          },
        }) : Promise.resolve([]),
        this.database.merchantKnowledgeSource.findMany({
          where: { shopId: principal.shopId, ...(afterPosition === null ? {} : { position: { gt: afterPosition } }) },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          take: MERCHANT_KNOWLEDGE_PAGE_SIZE + 1,
          select: {
            id: true, name: true, languageTag: true, position: true, currentGeneration: true,
            purpose: { select: { key: true, displayName: true, active: true } },
            dataFormat: { select: { key: true, displayName: true, active: true } },
            revisions: {
              orderBy: [{ generation: "desc" }, { id: "desc" }], take: 1,
              select: { id: true, generation: true, reason: true, status: true, requestedUrl: true,
                resolvedUrl: true, contentUnits: true, truncated: true, fetchedAt: true,
                completedAt: true, failureCode: true,
                uploadedAsset: { select: { originalFileName: true } },
              },
            },
          },
        }),
        allowed.length ? this.database.merchantKnowledgeSource.count({ where: allowedSourceWhere(principal.shopId, allowed) }) : Promise.resolve(0),
        allowed.length && afterPosition !== null
          ? this.database.merchantKnowledgeSource.count({ where: allowedSourceWhere(principal.shopId, allowed, { lte: afterPosition }) })
          : Promise.resolve(0),
      ]);
      const more = pageRows.length > MERCHANT_KNOWLEDGE_PAGE_SIZE;
      const page = pageRows.slice(0, MERCHANT_KNOWLEDGE_PAGE_SIZE);
      const active = await readActiveRevisions(this.database, page.map(({ id }) => id));
      let eligibleRank = precedingEligibleCount;
      const sources = page.map((row) => {
        const typeEligible = row.purpose.active && row.dataFormat.active &&
          allowedKeys.has(`${row.purpose.key}\u0000${row.dataFormat.key}`);
        if (typeEligible) eligibleRank += 1;
        return projectSource(row, allowedKeys, planEntitled, merchantEnabled,
          typeEligible && eligibleRank <= (configuration?.maxKnowledgeSources ?? 0), active.get(row.id));
      });
      return {
        schemaVersion: 1,
        state: !planEntitled ? "PLAN_UNENTITLED" : merchantEnabled ? "ENABLED" : "MERCHANT_DISABLED",
        planEntitled, merchantEnabled, effectiveEnabled: planEntitled && merchantEnabled,
        maxKnowledgeSources: configuration?.maxKnowledgeSources ?? 0,
        maxContentUnitsPerSource: configuration?.maxContentUnitsPerSource ?? 0,
        maxUploadBytes,
        configuredCount: allSourceCount, planEligibleSourceCount,
        defaultLanguageTag: resolveModaConfigurationLocale(defaultLanguage),
        supportedLanguageTags: MODA_SUPPORTED_LANGUAGE_TAGS,
        catalogue: catalogueRows.map(projectCatalogue),
        sources,
        nextPosition: more ? page[page.length - 1]!.position : null,
      };
    } catch (error) {
      if (error instanceof MerchantKnowledgeReadError) throw error;
      // Provider/database errors must not be confused with a subscription denial.
      throw new MerchantKnowledgeReadError(503, "merchant_knowledge_unavailable");
    }
  }
}
