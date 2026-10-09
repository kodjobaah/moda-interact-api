import type { PrismaClient } from "@prisma/client";
import { parseEffectiveRecoveryPolicy } from "@modainteract/moda-interact-shared/recovery-policy";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";

// Match the live Background RecoveryPolicyService fallback for shops without
// ShopSettings. A read must not create or modify merchant policy records.
export const UNCONFIGURED_RECOVERY_POLICY = {
  recoveryDelayMinutes: 30,
  recoveryOfferMode: "NONE" as const,
  fixedShopifyDiscountId: null,
  followUpEnabled: false,
  followUpDelayMinutes: null,
  source: "MERCHANT" as const,
};

export interface MerchantRecoverySummary {
  schemaVersion: 1;
  recoveryDelayMinutes: number;
  recoveryOfferMode: "NONE" | "FIXED" | "AI_BEST_APPLICABLE";
  followUpEnabled: boolean;
  followUpDelayMinutes: number | null;
  source: "MERCHANT" | "ADMIN_OVERRIDE";
}

type RecoverySummaryDatabase = Pick<
  PrismaClient,
  "shop" | "wooCommerceInstallation" | "shopSettings" | "shopRecoveryPolicyOverride"
>;

export class RecoverySummaryIntegrityError extends Error {
  constructor() {
    super("recovery_summary_integrity_invalid");
    this.name = "RecoverySummaryIntegrityError";
  }
}

/** Read the effective policy for the already-authenticated installation, not a browser-provided shopId. */
export class MerchantRecoverySummaryService {
  constructor(private readonly database: RecoverySummaryDatabase) {}

  async read(principal: WooInstallationPrincipal, now = new Date()): Promise<MerchantRecoverySummary> {
    const [shop, installation, merchant, override] = await Promise.all([
      this.database.shop.findUnique({
        where: { id: principal.shopId },
        select: { id: true, domain: true, platform: true, shopifyShopId: true, status: true },
      }),
      this.database.wooCommerceInstallation.findUnique({
        where: { id: principal.installationId },
        select: { id: true, shopId: true, canonicalSiteUrl: true, credentialVersion: true, status: true, revokedAt: true },
      }),
      this.database.shopSettings.findUnique({
        where: { shopId: principal.shopId },
        select: { recoveryDelayMinutes: true, recoveryOfferMode: true, fixedShopifyDiscountId: true, followUpEnabled: true, followUpDelayMinutes: true },
      }),
      this.database.shopRecoveryPolicyOverride.findUnique({
        where: { shopId: principal.shopId },
        select: { recoveryDelayMinutes: true, recoveryOfferMode: true, fixedShopifyDiscountId: true, followUpEnabled: true, followUpDelayMinutes: true, expiresAt: true },
      }),
    ]);

    if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
      shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE" ||
      !installation || installation.id !== principal.installationId ||
      installation.shopId !== principal.shopId || installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
      installation.credentialVersion !== principal.credentialVersion ||
      installation.status !== "ACTIVE" || installation.revokedAt !== null) {
      throw new RecoverySummaryIntegrityError();
    }

    const activeOverride = override && (override.expiresAt === null || override.expiresAt > now)
      ? override : null;
    const source = activeOverride ?? merchant;
    const effective = parseEffectiveRecoveryPolicy(source ? {
      recoveryDelayMinutes: source.recoveryDelayMinutes,
      recoveryOfferMode: source.recoveryOfferMode,
      fixedShopifyDiscountId: source.fixedShopifyDiscountId,
      followUpEnabled: source.followUpEnabled,
      followUpDelayMinutes: source.followUpEnabled ? source.followUpDelayMinutes : null,
      source: activeOverride ? "ADMIN_OVERRIDE" : "MERCHANT",
    } : UNCONFIGURED_RECOVERY_POLICY);

    return {
      schemaVersion: 1,
      recoveryDelayMinutes: effective.recoveryDelayMinutes,
      recoveryOfferMode: effective.recoveryOfferMode,
      followUpEnabled: effective.followUpEnabled,
      followUpDelayMinutes: effective.followUpDelayMinutes,
      source: effective.source,
    };
  }
}
