import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { selectCapabilities } from "@modainteract/moda-interact-shared/commerce";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import {
  FeaturePreferencesConflictError, FeaturePreferencesIntegrityError,
  isFeaturePreferencesResponse, type FeaturePreferencesResponse, type FeaturePreferencesUpdate,
} from "./contract.js";

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

async function load(tx: Tx, shopId: string): Promise<FeaturePreferencesResponse> {
  const subscription = await tx.subscription.findUnique({
    where: { shopId },
    include: { plan: { include: { features: { include: { feature: true }, orderBy: { featureId: "asc" } } } } },
  });
  if (!subscription || !["ACTIVE", "TRIALING"].includes(subscription.status) ||
    !subscription.plan || !subscription.plan.active) {
    throw new FeaturePreferencesConflictError("feature_preferences_unavailable");
  }
  const [features, preferences] = await Promise.all([
    tx.feature.findMany({ where: { active: true }, orderBy: [{ displayName: "asc" }, { id: "asc" }] }),
    tx.shopFeaturePreference.findMany({ where: { shopId }, orderBy: { featureId: "asc" } }),
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
  const response: FeaturePreferencesResponse = {
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
  };
  if (!isFeaturePreferencesResponse(response)) throw new FeaturePreferencesIntegrityError();
  return response;
}

export class MerchantFeaturePreferencesService {
  constructor(private readonly database: Database) {}

  async read(principal: WooInstallationPrincipal): Promise<FeaturePreferencesResponse> {
    return this.database.$transaction(async (tx) => {
      await assertInstallation(tx, principal, false);
      return load(tx, principal.shopId);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async update(principal: WooInstallationPrincipal, input: FeaturePreferencesUpdate): Promise<FeaturePreferencesResponse> {
    try {
      return await this.database.$transaction(async (tx) => {
        await assertInstallation(tx, principal, true);
        const current = await load(tx, principal.shopId);
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
        return load(tx, principal.shopId);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
        throw new FeaturePreferencesConflictError("feature_preferences_conflict");
      }
      throw error;
    }
  }
}
