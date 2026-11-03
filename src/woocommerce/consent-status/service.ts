import { Prisma, type PrismaClient } from "@prisma/client";
import { normalizeRecipientPhone } from "@modainteract/moda-interact-shared/identity";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { WOO_CONSENT_STATUS_VERSION, type WooConsentStatusProbe,
  type WooConsentStatusResult } from "./contract.js";

type ReadDatabase = Pick<PrismaClient, "$queryRaw">;
type Match = { matched: number };

/** One indexed read after the installation authenticator's single DB lookup.
 * No explicit transaction: PostgreSQL supplies a consistent READ COMMITTED
 * statement snapshot, including a REVOKE committed before that snapshot.
 *
 * The extra installation/shop predicates revalidate the current principal in
 * this SAME read, so a stale principal cannot confirm consent after rotation.
 */
export class WooConsentStatusService {
  constructor(private readonly database: ReadDatabase) {}

  async read(principal: WooInstallationPrincipal, probe: WooConsentStatusProbe): Promise<WooConsentStatusResult> {
    const normalized = normalizeRecipientPhone(`+${probe.canonicalPhone}`);
    if (!normalized.ok || normalized.e164.slice(1) !== probe.canonicalPhone) {
      return { schemaVersion: WOO_CONSENT_STATUS_VERSION, state: "UNVERIFIED" };
    }

    const rows = await this.database.$queryRaw<Match[]>(Prisma.sql`
      SELECT 1::integer AS "matched"
      FROM "commerce"."WhatsAppConsentEvidence" e
      JOIN "commerce"."CustomerPhone" cp
        ON cp."id" = e."customerPhoneId" AND cp."customerId" = e."customerId"
      JOIN "commerce"."Customer" c
        ON c."id" = e."customerId" AND c."shopId" = e."shopId"
      JOIN "woocommerce"."WooCommerceInstallation" i
        ON i."id" = e."installationId" AND i."shopId" = e."shopId"
      JOIN "commerce"."Shop" s ON s."id" = e."shopId"
      WHERE e."shopId" = ${principal.shopId} AND e."eventId" = ${probe.grantEventId}
        AND e."installationId" = ${principal.installationId}
        AND e."canonicalPhone" = ${probe.canonicalPhone}
        AND e."decision" = 'GRANT'::"commerce"."WhatsAppConsentEvidenceDecision"
        AND e."purpose" = 'WHATSAPP_CHECKOUT_RECOVERY'::"commerce"."WhatsAppConsentPurpose"
        AND i."credentialVersion" = ${principal.credentialVersion}
        AND i."canonicalSiteUrl" = ${principal.canonicalSiteUrl}
        AND i."canonicalSiteUrl" = s."domain"
        AND i."status" = 'ACTIVE'::"woocommerce"."WooCommerceInstallationStatus"
        AND i."revokedAt" IS NULL
        AND s."domain" = ${principal.canonicalSiteUrl}
        AND s."platform" = 'WOOCOMMERCE'::"commerce"."ShopPlatform"
        AND s."status" = 'ACTIVE'::"commerce"."ShopStatus"
        AND s."shopifyShopId" IS NULL
        AND cp."endedAt" IS NULL
        AND cp."whatsappCanonicalPhone" = e."canonicalPhone"
        AND cp."whatsappConsentPurpose" = e."purpose"
        AND cp."whatsappConsentDecision" = 'GRANTED'::"commerce"."WhatsAppRecoveryConsentDecision"
        AND cp."whatsappConsentSource" = 'WOO_MODA_CHECKBOX'::"commerce"."WhatsAppRecoveryConsentSource"
        AND cp."whatsappConsentRevision" = e."phoneConsentRevision"
        AND cp."whatsappConsentDecisionSequence" = e."decisionSequence"
        AND cp."whatsappPhoneVerifiedAt" IS NOT NULL
        AND cp."whatsappConsentVerifiedAt" IS NOT NULL
        AND cp."whatsappConsentProviderObservedAt" = e."decisionAt"
      LIMIT 1
    `);
    return { schemaVersion: WOO_CONSENT_STATUS_VERSION,
      state: rows.length === 1 ? "CONFIRMED_GRANTED" : "UNVERIFIED" };
  }
}
