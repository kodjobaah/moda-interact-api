import { Prisma, type PrismaClient } from "@prisma/client";
import { parseEffectiveRecoveryPolicy } from "@modainteract/moda-interact-shared/recovery-policy";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";

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
  "$queryRaw"
>;

interface RecoverySummaryRow {
  shopId: string;
  domain: string;
  platform: string;
  shopifyShopId: string | null;
  shopStatus: string;
  installationId: string | null;
  installationShopId: string | null;
  canonicalSiteUrl: string | null;
  credentialVersion: number | null;
  installationStatus: string | null;
  revokedAt: Date | null;
  merchantRecoveryDelayMinutes: number | null;
  merchantRecoveryOfferMode: string | null;
  merchantFixedDiscountId: string | null;
  merchantFollowUpEnabled: boolean | null;
  merchantFollowUpDelayMinutes: number | null;
  overrideId: string | null;
  overrideRecoveryDelayMinutes: number | null;
  overrideRecoveryOfferMode: string | null;
  overrideFixedDiscountId: string | null;
  overrideFollowUpEnabled: boolean | null;
  overrideFollowUpDelayMinutes: number | null;
  overrideExpiresAt: Date | null;
}

export class RecoverySummaryIntegrityError extends Error {
  constructor(options?: ErrorOptions) {
    super("recovery_summary_integrity_invalid", options);
    this.name = "RecoverySummaryIntegrityError";
  }
}

/** Read the effective policy for the already-authenticated installation, not a browser-provided shopId. */
export class MerchantRecoverySummaryService {
  constructor(private readonly database: RecoverySummaryDatabase) {}

  async read(principal: WooInstallationPrincipal, now = new Date()): Promise<MerchantRecoverySummary> {
    const rows = await this.database.$queryRaw<RecoverySummaryRow[]>(Prisma.sql`
      SELECT
        s."id" AS "shopId", s."domain", s."platform", s."shopifyShopId", s."status" AS "shopStatus",
        i."id" AS "installationId", i."shopId" AS "installationShopId", i."canonicalSiteUrl",
        i."credentialVersion", i."status" AS "installationStatus", i."revokedAt",
        settings."recoveryDelayMinutes" AS "merchantRecoveryDelayMinutes",
        settings."recoveryOfferMode" AS "merchantRecoveryOfferMode",
        settings."fixedShopifyDiscountId" AS "merchantFixedDiscountId",
        settings."followUpEnabled" AS "merchantFollowUpEnabled",
        settings."followUpDelayMinutes" AS "merchantFollowUpDelayMinutes",
        override."id" AS "overrideId",
        override."recoveryDelayMinutes" AS "overrideRecoveryDelayMinutes",
        override."recoveryOfferMode" AS "overrideRecoveryOfferMode",
        override."fixedShopifyDiscountId" AS "overrideFixedDiscountId",
        override."followUpEnabled" AS "overrideFollowUpEnabled",
        override."followUpDelayMinutes" AS "overrideFollowUpDelayMinutes",
        override."expiresAt" AS "overrideExpiresAt"
      FROM "commerce"."Shop" s
      LEFT JOIN "woocommerce"."WooCommerceInstallation" i
        ON i."id" = ${principal.installationId} AND i."shopId" = s."id"
      LEFT JOIN "shopify"."ShopSettings" settings ON settings."shopId" = s."id"
      LEFT JOIN "shopify"."ShopRecoveryPolicyOverride" override ON override."shopId" = s."id"
      WHERE s."id" = ${principal.shopId}
    `);
    const row = rows[0];
    if (!row || row.shopId !== principal.shopId || row.domain !== principal.canonicalSiteUrl ||
      row.platform !== "WOOCOMMERCE" || row.shopifyShopId !== null || row.shopStatus !== "ACTIVE" ||
      row.installationId !== principal.installationId || row.installationShopId !== principal.shopId ||
      row.canonicalSiteUrl !== principal.canonicalSiteUrl || row.credentialVersion !== principal.credentialVersion ||
      row.installationStatus !== "ACTIVE" || row.revokedAt !== null) {
      throw new RecoverySummaryIntegrityError();
    }

    const merchant = row.merchantRecoveryDelayMinutes === null ? null : {
      recoveryDelayMinutes: row.merchantRecoveryDelayMinutes,
      recoveryOfferMode: row.merchantRecoveryOfferMode,
      fixedShopifyDiscountId: row.merchantFixedDiscountId,
      followUpEnabled: row.merchantFollowUpEnabled,
      followUpDelayMinutes: row.merchantFollowUpDelayMinutes,
    };
    const override = row.overrideId === null ? null : {
      recoveryDelayMinutes: row.overrideRecoveryDelayMinutes,
      recoveryOfferMode: row.overrideRecoveryOfferMode,
      fixedShopifyDiscountId: row.overrideFixedDiscountId,
      followUpEnabled: row.overrideFollowUpEnabled,
      followUpDelayMinutes: row.overrideFollowUpDelayMinutes,
      expiresAt: row.overrideExpiresAt,
    };
    const activeOverride = override && (override.expiresAt === null || override.expiresAt > now) ? override : null;
    const source = activeOverride ?? merchant;
    let effective;
    try {
      effective = parseEffectiveRecoveryPolicy(source ? {
        recoveryDelayMinutes: source.recoveryDelayMinutes,
        recoveryOfferMode: source.recoveryOfferMode,
        fixedShopifyDiscountId: source.fixedShopifyDiscountId,
        followUpEnabled: source.followUpEnabled,
        followUpDelayMinutes: source.followUpEnabled ? source.followUpDelayMinutes : null,
        source: activeOverride ? "ADMIN_OVERRIDE" : "MERCHANT",
      } : UNCONFIGURED_RECOVERY_POLICY);
    } catch (cause) {
      throw new RecoverySummaryIntegrityError({ cause });
    }

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
