import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma, type PrismaClient } from "@prisma/client";
import { selectCapabilities } from "@modainteract/moda-interact-shared/commerce";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import {
  FeaturePreferencesConflictError, FeaturePreferencesIntegrityError,
  isFeaturePreferencesResponse, type FeaturePreferencesResponse, type FeaturePreferencesUpdate,
} from "./contract.js";
import { elapsedFeatureMs, timeFeaturePhase, timeFeatureSync, type FeaturePreferencesTimings } from "./timing.js";
import {
  measureFeaturePreferencePhase, measureFeaturePreferenceProjection,
  type FeaturePreferenceLoadPhase, type FeaturePreferenceLoadTimings, type FeaturePreferenceTimingSink,
} from "./timing.js";

type Database = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;

type ShopIdentity = { id: string; domain: string; platform: string; shopifyShopId: string | null; status: string };
type InstallationIdentity = { id: string; shopId: string; canonicalSiteUrl: string; credentialVersion: number; status: string; revokedAt: Date | null };

/** Reverify the principal inside the transaction, after acquiring the write lock. */
async function assertInstallation(tx: Tx, principal: WooInstallationPrincipal, write: boolean,
  timings?: FeaturePreferencesTimings): Promise<void> {
  const shops = await timeFeaturePhase(timings, "shopLookupMs", async () => write ? await tx.$queryRaw<ShopIdentity[]>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `) : await tx.$queryRaw<ShopIdentity[]>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId}
  `));
  const shop = shops[0];
  const validShop = timeFeatureSync(timings, "shopValidationMs", () => {
    if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
      shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE") {
      throw new FeaturePreferencesIntegrityError();
    }
    return shop;
  });
  const installations = await timeFeaturePhase(timings, "installationLookupMs", async () => write ? await tx.$queryRaw<InstallationIdentity[]>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "credentialVersion", "status", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId} FOR SHARE
  `) : await tx.$queryRaw<InstallationIdentity[]>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "credentialVersion", "status", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId}
  `));
  const installation = installations[0];
  timeFeatureSync(timings, "installationValidationMs", () => {
    if (!installation || installation.id !== principal.installationId || installation.shopId !== validShop.id ||
      installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
      installation.credentialVersion !== principal.credentialVersion || installation.status !== "ACTIVE" ||
      installation.revokedAt !== null) throw new FeaturePreferencesIntegrityError();
  });
}

async function load(tx: Tx, shopId: string, phase: FeaturePreferenceLoadPhase,
  timings: FeaturePreferencesTimings | undefined, loadTimings: FeaturePreferenceLoadTimings): Promise<FeaturePreferencesResponse> {
  const subscription = await measureFeaturePreferencePhase(loadTimings, phase, "subscriptionLookupMs", () =>
      timeFeaturePhase(timings, "subscriptionLookupMs", async () => tx.subscription.findUnique({
      where: { shopId },
      select: {
        id: true, status: true, planId: true,
        plan: { select: { id: true, active: true, updatedAt: true, features: {
          orderBy: { featureId: "asc" },
          select: { featureId: true, enabled: true, feature: { select: { active: true, updatedAt: true } } },
        } } },
      },
    })));
  const { activeSubscription, plan } = timeFeatureSync(timings, "subscriptionEligibilityMs", () => {
    if (!subscription || !["ACTIVE", "TRIALING"].includes(subscription.status) ||
      !subscription.plan || !subscription.plan.active) {
      throw new FeaturePreferencesConflictError("feature_preferences_unavailable");
    }
    return { activeSubscription: subscription, plan: subscription.plan };
  });
  const [features, preferences] = await Promise.all([
    measureFeaturePreferencePhase(loadTimings, phase, "featuresLookupMs", () => timeFeaturePhase(timings, "featuresLookupMs", async () => tx.feature.findMany({
      where: { active: true }, orderBy: [{ displayName: "asc" }, { id: "asc" }],
      select: { id: true, key: true, displayName: true, description: true, active: true,
        activationMode: true, systemRequired: true, updatedAt: true },
    }))),
    measureFeaturePreferencePhase(loadTimings, phase, "preferencesLookupMs", () => timeFeaturePhase(timings, "preferencesLookupMs", async () => tx.shopFeaturePreference.findMany({
      where: { shopId }, orderBy: { featureId: "asc" }, select: { featureId: true, enabled: true, updatedAt: true },
    }))),
  ]);
  const mappingIds = new Set(plan.features.filter((mapping) => mapping.enabled && mapping.feature.active)
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
  const selected = timeFeatureSync(timings, "capabilitySelectionMs", () => new Set(selectCapabilities(features.map((feature, position) => ({
    key: `feature_${position}`, featureId: feature.id, enabled: true, position,
  })), { features: facts })));
  const response = measureFeaturePreferenceProjection(loadTimings, phase, () => timeFeatureSync(timings, "projectionMs", (): FeaturePreferencesResponse => ({
    schemaVersion: 1,
    revision: createHash("sha256").update(JSON.stringify({
      subscription: [activeSubscription.id, activeSubscription.status, activeSubscription.planId],
      plan: [plan.id, plan.active, plan.updatedAt],
      mappings: plan.features.map((m) => [m.featureId, m.enabled, m.feature.active, m.feature.updatedAt]),
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
  })));
  timeFeatureSync(timings, "responseValidationMs", () => {
    if (!isFeaturePreferencesResponse(response)) throw new FeaturePreferencesIntegrityError();
  });
  return response;
}

/** Time the actual Prisma transaction lifecycle, separating callback entry/work/finish.
 * Entry includes connection acquisition and transaction setup; it is not a pure pool-wait metric.
 * Finish includes commit/rollback and client completion. */
async function runTransaction<T>(database: Database, isolationLevel: Prisma.TransactionIsolationLevel,
  action: (tx: Tx) => Promise<T>, timings?: FeaturePreferencesTimings): Promise<T> {
  const initiatedAt = performance.now();
  try {
    return await timeFeaturePhase(timings, "transactionMs", () => database.$transaction(async (tx) => {
      if (timings) timings.transactionEntryMs = elapsedFeatureMs(initiatedAt);
      const workStartedAt = performance.now();
      try { return await action(tx); }
      finally { if (timings) timings.transactionWorkMs = elapsedFeatureMs(workStartedAt); }
    }, { isolationLevel }));
  } finally {
    if (timings?.transactionMs !== undefined && timings.transactionEntryMs !== undefined &&
        timings.transactionWorkMs !== undefined) {
      timings.transactionFinishMs = Math.max(0, Math.round((timings.transactionMs -
        timings.transactionEntryMs - timings.transactionWorkMs) * 100) / 100);
    }
  }
}

export class MerchantFeaturePreferencesService {
  constructor(private readonly database: Database) {}

  async read(principal: WooInstallationPrincipal,
    timingTarget?: FeaturePreferencesTimings | FeaturePreferenceTimingSink): Promise<FeaturePreferencesResponse> {
    const timings = typeof timingTarget === "function" ? undefined : timingTarget;
    const loadTimings: FeaturePreferenceLoadTimings = {};
    return runTransaction(this.database, Prisma.TransactionIsolationLevel.RepeatableRead, async (tx) => {
      await assertInstallation(tx, principal, false, timings);
      return load(tx, principal.shopId, "initial", timings, loadTimings);
    }, timings).finally(() => {
      if (typeof timingTarget === "function") timingTarget(loadTimings);
      else if (timings) Object.assign(timings, loadTimings);
    });
  }

  async update(principal: WooInstallationPrincipal, input: FeaturePreferencesUpdate,
    timingTarget?: FeaturePreferencesTimings | FeaturePreferenceTimingSink): Promise<FeaturePreferencesResponse> {
    const timings = typeof timingTarget === "function" ? undefined : timingTarget;
    const loadTimings: FeaturePreferenceLoadTimings = {};
    try {
      return await runTransaction(this.database, Prisma.TransactionIsolationLevel.ReadCommitted, async (tx) => {
        await assertInstallation(tx, principal, true, timings);
        const current = await load(tx, principal.shopId, "initial", timings, loadTimings);
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
        await timeFeaturePhase(timings, "featureUpsertsMs", async () => {
          for (const change of changed) {
            await tx.shopFeaturePreference.upsert({
              where: { shopId_featureId: { shopId: principal.shopId, featureId: change.featureId } },
              create: { shopId: principal.shopId, featureId: change.featureId, enabled: change.enabled },
              update: { enabled: change.enabled },
            });
          }
        });
        return load(tx, principal.shopId, "final", timings, loadTimings);
      }, timings);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
        throw new FeaturePreferencesConflictError("feature_preferences_conflict", { cause: error });
      }
      throw error;
    } finally {
      if (typeof timingTarget === "function") timingTarget(loadTimings);
      else if (timings) Object.assign(timings, loadTimings);
    }
  }
}
