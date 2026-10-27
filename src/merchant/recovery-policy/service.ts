import { Prisma, type PrismaClient, type ShopSettings, type ShopRecoveryPolicyOverride } from "@prisma/client";
import { parseEffectiveRecoveryPolicy } from "@modainteract/moda-interact-shared/recovery-policy";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { RecoveryPolicyConflictError, RecoveryPolicyIntegrityError,
  type MerchantRecoveryPolicyResponse, type RecoveryPolicyUpdate, type RecoveryPolicyValues } from "./contract.js";
import { UNCONFIGURED_RECOVERY_POLICY } from "../recovery-summary/recovery-summary.service.js";

type PolicyDatabase = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;
type Settings = ShopSettings;
type Override = ShopRecoveryPolicyOverride;

interface ShopIdentity { id: string; domain: string; platform: string; shopifyShopId: string | null; status: string; onboardingCompleted: boolean }
interface InstallationIdentity { id: string; shopId: string; canonicalSiteUrl: string; credentialVersion: number; status: string; revokedAt: Date | null }

/** Every read/write rechecks the installation's Shop, not merely the bearer credential. */
async function assertCurrentShop(tx: Tx, principal: WooInstallationPrincipal, write: boolean): Promise<ShopIdentity> {
  const shops = write ? await tx.$queryRaw<ShopIdentity[]>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status", "onboardingCompleted"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `) : await tx.$queryRaw<ShopIdentity[]>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status", "onboardingCompleted"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId}
  `);
  const shop = shops[0];
  if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
    shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE") {
    throw new RecoveryPolicyIntegrityError();
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
    installation.credentialVersion !== principal.credentialVersion ||
    installation.status !== "ACTIVE" || installation.revokedAt !== null) throw new RecoveryPolicyIntegrityError();
  return shop;
}

function policyValues(source: Settings | Override | typeof UNCONFIGURED_RECOVERY_POLICY, origin: "MERCHANT" | "ADMIN_OVERRIDE"): RecoveryPolicyValues {
  try {
    const policy = parseEffectiveRecoveryPolicy({
      recoveryDelayMinutes: source.recoveryDelayMinutes,
      recoveryOfferMode: source.recoveryOfferMode,
      fixedShopifyDiscountId: source.fixedShopifyDiscountId,
      followUpEnabled: source.followUpEnabled,
      followUpDelayMinutes: source.followUpEnabled ? source.followUpDelayMinutes : null,
      source: origin,
    });
    return { recoveryDelayMinutes: policy.recoveryDelayMinutes, recoveryOfferMode: policy.recoveryOfferMode,
      followUpEnabled: policy.followUpEnabled, followUpDelayMinutes: policy.followUpDelayMinutes };
  } catch {
    throw new RecoveryPolicyIntegrityError();
  }
}

async function projection(tx: Tx, principal: WooInstallationPrincipal, now: Date,
  settings: Settings | null): Promise<MerchantRecoveryPolicyResponse> {
  const override = await tx.shopRecoveryPolicyOverride.findUnique({ where: { shopId: principal.shopId } });
  const active = override && (override.expiresAt === null || override.expiresAt > now) ? override : null;
  return {
    schemaVersion: 2,
    revision: settings?.updatedAt.toISOString() ?? "UNCONFIGURED",
    merchant: policyValues(settings ?? UNCONFIGURED_RECOVERY_POLICY, "MERCHANT"),
    effective: policyValues(active ?? settings ?? UNCONFIGURED_RECOVERY_POLICY, active ? "ADMIN_OVERRIDE" : "MERCHANT"),
    source: active ? "ADMIN_OVERRIDE" : "MERCHANT",
    overrideActive: Boolean(active),
    offerSelectionAvailable: false,
    notifyOnInitialRecoveryOutreach: settings?.notifyOnInitialRecoveryOutreach ?? false,
  };
}

function matches(settings: Settings | null, update: RecoveryPolicyUpdate): boolean {
  const current = settings ?? UNCONFIGURED_RECOVERY_POLICY;
  return current.recoveryOfferMode === "NONE" && current.fixedShopifyDiscountId === null &&
    current.recoveryDelayMinutes === update.recoveryDelayMinutes &&
    current.followUpEnabled === update.followUpEnabled &&
    (current.followUpEnabled ? current.followUpDelayMinutes : null) === update.followUpDelayMinutes &&
    (settings?.notifyOnInitialRecoveryOutreach ?? false) === update.notifyOnInitialRecoveryOutreach;
}

/** Merchant writes serialise on the same Shop row as Shopify policy writes; admin overrides remain untouched. */
export class MerchantRecoveryPolicyService {
  constructor(private readonly database: PolicyDatabase, private readonly now: () => Date = () => new Date()) {}

  async read(principal: WooInstallationPrincipal): Promise<MerchantRecoveryPolicyResponse> {
    return this.database.$transaction(async (tx) => {
      await assertCurrentShop(tx, principal, false);
      const settings = await tx.shopSettings.findUnique({ where: { shopId: principal.shopId } });
      return projection(tx, principal, this.now(), settings);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async update(principal: WooInstallationPrincipal, input: RecoveryPolicyUpdate): Promise<MerchantRecoveryPolicyResponse> {
    try {
      return await this.database.$transaction(async (tx) => {
        const shop = await assertCurrentShop(tx, principal, true);
        const current = await tx.shopSettings.findUnique({ where: { shopId: principal.shopId } });
        // Never retain or mutate a historical Shopify discount selection on Woo.
        if (current && (current.recoveryOfferMode !== "NONE" || current.fixedShopifyDiscountId !== null)) {
          throw new RecoveryPolicyConflictError("recovery_offer_unsupported");
        }
        if (matches(current, input)) return projection(tx, principal, this.now(), current);
        if ((current?.updatedAt.toISOString() ?? "UNCONFIGURED") !== input.expectedRevision) {
          throw new RecoveryPolicyConflictError("recovery_policy_conflict");
        }
        const time = this.now();
        const updatedAt = new Date(Math.max(time.getTime(), (current?.updatedAt.getTime() ?? 0) + 1));
        const data = { recoveryDelayMinutes: input.recoveryDelayMinutes, followUpEnabled: input.followUpEnabled,
          followUpDelayMinutes: input.followUpDelayMinutes,
          notifyOnInitialRecoveryOutreach: input.notifyOnInitialRecoveryOutreach, updatedAt };
        const next = current
          ? await tx.shopSettings.update({ where: { shopId: principal.shopId }, data })
          : await tx.shopSettings.create({ data: { shopId: principal.shopId, onboardingCompleted: shop.onboardingCompleted,
            recoveryOfferMode: "NONE", fixedShopifyDiscountId: null, ...data } });
        return projection(tx, principal, time, next);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
        throw new RecoveryPolicyConflictError("recovery_policy_conflict");
      }
      throw error;
    }
  }
}
