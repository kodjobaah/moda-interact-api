import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { selectCapabilities } from "@modainteract/moda-interact-shared/commerce";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import {
  FeaturePreferencesConflictError, FeaturePreferencesIntegrityError,
  isFeaturePreferencesResponse, type FeaturePreferencesResponse, type FeaturePreferencesUpdate,
} from "./contract.js";
import {
  measureFeaturePreferencePhase, measureFeaturePreferenceProjection,
  type FeaturePreferenceLoadPhase, type FeaturePreferenceLoadTimings, type FeaturePreferenceTimingSink,
} from "./timing.js";

type Database = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;

type ShopIdentity = { id: string; domain: string; platform: string; shopifyShopId: string | null; status: string };
type InstallationIdentity = { id: string; shopId: string; canonicalSiteUrl: string; credentialVersion: number; status: string; revokedAt: Date | null };

/** Reverify the principal inside the transaction, after acquiring the write lock. */
async function assertInstallation(tx: Tx, principal: WooInstallationPrincipal, write: boolean): Promise<void> {
  const shops = write ? await tx.$queryRaw<ShopIdentity[]>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `) : await tx.$queryRaw<ShopIdentity[]>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId}
  `);
  const shop = shops[0];
  if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
    shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE") {
    throw new FeaturePreferencesIntegrityError();
  }
  const installations = write ? await tx.$queryRaw<InstallationIdentity[]>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "credentialVersion", "status", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId} FOR SHARE
  `) : await tx.$queryRaw<InstallationIdentity[]>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "credentialVersion", "status", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId}
  `);
  const installation = installations[0];
  if (!installation || installation.id !== principal.installationId || installation.shopId !== shop.id ||
    installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
    installation.credentialVersion !== principal.credentialVersion || installation.status !== "ACTIVE" ||
    installation.revokedAt !== null) throw new FeaturePreferencesIntegrityError();
}

async function load(tx: Tx, shopId: string, phase: FeaturePreferenceLoadPhase,
  timings: FeaturePreferenceLoadTimings): Promise<FeaturePreferencesResponse> {
  const subscription = await measureFeaturePreferencePhase(timings, phase, "subscriptionLookupMs", () => tx.subscription.findUnique({
    where: { shopId },
    select: {
      id: true, status: true, planId: true,
      plan: { select: { id: true, active: true, updatedAt: true, features: {
        orderBy: { featureId: "asc" },
        select: { featureId: true, enabled: true, feature: { select: { active: true, updatedAt: true } } },
      } } },
    },
  }));
  if (!subscription || !["ACTIVE", "TRIALING"].includes(subscription.status) ||
    !subscription.plan || !subscription.plan.active) {
    throw new FeaturePreferencesConflictError("feature_preferences_unavailable");
  }
  const [features, preferences] = await Promise.all([
    measureFeaturePreferencePhase(timings, phase, "featuresLookupMs", () => tx.feature.findMany({
      where: { active: true }, orderBy: [{ displayName: "asc" }, { id: "asc" }],
      select: { id: true, key: true, displayName: true, description: true, active: true,
        activationMode: true, systemRequired: true, updatedAt: true },
    })),
    measureFeaturePreferencePhase(timings, phase, "preferencesLookupMs", () => tx.shopFeaturePreference.findMany({
      where: { shopId }, orderBy: { featureId: "asc" }, select: { featureId: true, enabled: true, updatedAt: true },
    })),
  ]);
  const mappingIds = new Set(subscription.plan.features.filter((mapping) => mapping.enabled && mapping.feature.active)
    .map((mapping) => mapping.featureId));
  const preferenceByFeature = new Map(preferences.map((p) => [p.featureId, p]));
  const facts = features.map((feature) => ({
    id: feature.id,
    active: feature.active,
    planMappingEnabled: mappingIds.has(feature.id),
    mode: feature.activationMode,
    preferenceEnabled: preferenceByFeature.get(feature.id)?.enabled ?? false,
  }));
  // The published Shared selector, not this API, owns effective capability activation semantics.
  const selected = new Set(selectCapabilities(features.map((feature, position) => ({
    key: `feature_${position}`, featureId: feature.id, enabled: true, position,
  })), { features: facts }));
  const response = measureFeaturePreferenceProjection(timings, phase, (): FeaturePreferencesResponse => ({
    schemaVersion: 1,
    revision: createHash("sha256").update(JSON.stringify({
      subscription: [subscription.id, subscription.status, subscription.planId],
      plan: [subscription.plan.id, subscription.plan.active, subscription.plan.updatedAt],
      mappings: subscription.plan.features.map((m) => [m.featureId, m.enabled, m.feature.active, m.feature.updatedAt]),
      features: features.map((f) => [f.id, f.key, f.displayName, f.description, f.active, f.activationMode, f.systemRequired, f.updatedAt]),
      preferences: preferences.map((p) => [p.featureId, p.enabled, p.updatedAt]),
    })).digest("hex"),
    features: features.map((feature, position) => {
      const planEligible = mappingIds.has(feature.id);
      const required = feature.systemRequired || feature.activationMode === "ALWAYS_ENABLED";
      return {
        id: feature.id, key: feature.key, name: feature.displayName, description: feature.description,
        enabled: preferenceByFeature.get(feature.id)?.enabled ?? false,
        effective: selected.has(`feature_${position}`),
        editable: planEligible && !required && feature.activationMode === "MERCHANT_OPT_IN",
        required, planEligible,
      };
    }),
  }));
  if (!isFeaturePreferencesResponse(response)) throw new FeaturePreferencesIntegrityError();
  return response;
}

export class MerchantFeaturePreferencesService {
  constructor(private readonly database: Database) {}

  async read(principal: WooInstallationPrincipal, reportTimings?: FeaturePreferenceTimingSink): Promise<FeaturePreferencesResponse> {
    const timings: FeaturePreferenceLoadTimings = {};
    try { return await this.database.$transaction(async (tx) => {
      await assertInstallation(tx, principal, false);
      return load(tx, principal.shopId, "initial", timings);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }); }
    finally { reportTimings?.(timings); }
  }

  async update(principal: WooInstallationPrincipal, input: FeaturePreferencesUpdate,
    reportTimings?: FeaturePreferenceTimingSink): Promise<FeaturePreferencesResponse> {
    const timings: FeaturePreferenceLoadTimings = {};
    try {
      return await this.database.$transaction(async (tx) => {
        await assertInstallation(tx, principal, true);
        const current = await load(tx, principal.shopId, "initial", timings);
        // Compare revisions before no-op checks: even identical stale requests must not bypass CAS.
        if (current.revision !== input.expectedRevision) {
          throw new FeaturePreferencesConflictError("feature_preferences_conflict");
        }
        for (const change of input.changes) {
          if (!current.features.some((feature) => feature.id === change.featureId && feature.editable)) {
            throw new FeaturePreferencesConflictError("feature_preferences_denied");
          }
        }
        const changed = input.changes.filter((change) =>
          current.features.find((feature) => feature.id === change.featureId)?.enabled !== change.enabled);
        if (!changed.length) return current;
        for (const change of changed) {
          await tx.shopFeaturePreference.upsert({
            where: { shopId_featureId: { shopId: principal.shopId, featureId: change.featureId } },
            create: { shopId: principal.shopId, featureId: change.featureId, enabled: change.enabled },
            update: { enabled: change.enabled },
          });
        }
        return load(tx, principal.shopId, "final", timings);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
        throw new FeaturePreferencesConflictError("feature_preferences_conflict", { cause: error });
      }
      throw error;
    } finally { reportTimings?.(timings); }
  }
}
