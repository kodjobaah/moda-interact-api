import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { normalizeRecipientPhone } from "@modainteract/moda-interact-shared/identity";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { WooConsentHttpError, WOO_CONSENT_VERSION,
  type WooConsentEvent, type WooConsentResult } from "./contract.js";

type Database = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;
type Shop = { id: string; domain: string; platform: string; status: string; shopifyShopId: string | null };
type Installation = { id: string; shopId: string; canonicalSiteUrl: string; status: string;
  credentialVersion: number; revokedAt: Date | null };
type Phone = { id: string; customerId: string; whatsappCanonicalPhone: string | null;
  whatsappConsentSource: string | null; whatsappConsentDecision: string;
  whatsappConsentRevision: bigint; whatsappConsentDecisionSequence: bigint;
  whatsappConsentProviderObservedAt: Date | null; whatsappNoContact: boolean;
  whatsappNoContactReason: string | null };
type Evidence = { payloadDigest: Uint8Array; decision: "GRANT" | "REVOKE";
  phoneConsentRevision: bigint; decisionSequence: bigint };
const conflict = (code: string) => new WooConsentHttpError(409, code);

/** Called *inside* the write transaction so a revoked/rotated installation
 * cannot race the initial HTTP bearer authentication. */
async function verifyInstallation(tx: Tx, principal: WooInstallationPrincipal): Promise<void> {
  const shops = await tx.$queryRaw<Shop[]>(Prisma.sql`
    SELECT "id", "domain", "platform"::text AS "platform", "status"::text AS "status", "shopifyShopId"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR SHARE
  `);
  const shop = shops[0];
  if (!shop || shop.domain !== principal.canonicalSiteUrl || shop.platform !== "WOOCOMMERCE" ||
    shop.shopifyShopId !== null || shop.status !== "ACTIVE") throw new WooUnauthenticatedError();
  const installations = await tx.$queryRaw<Installation[]>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "status"::text AS "status", "credentialVersion", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId} FOR SHARE
  `);
  const i = installations[0];
  if (!i || i.shopId !== principal.shopId || i.canonicalSiteUrl !== shop.domain ||
    i.credentialVersion !== principal.credentialVersion || i.status !== "ACTIVE" ||
    i.revokedAt !== null) throw new WooUnauthenticatedError();
}

/** A stale page cannot grant when recovery has been disabled for this shop. */
async function requireRecoveryFeature(tx: Tx, shopId: string): Promise<void> {
  const result = await tx.$queryRaw<Array<{ eligible: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "billing"."Subscription" s
      JOIN "billing"."BillingPlan" p ON p."id" = s."planId"
      JOIN "billing"."BillingPlanFeature" pf ON pf."planId" = p."id" AND pf."enabled"
      JOIN "billing"."Feature" f ON f."id" = pf."featureId"
      WHERE s."shopId" = ${shopId} AND s."status" IN ('ACTIVE', 'TRIALING')
        AND p."active" AND f."active" AND f."key" = 'checkout_recovery'
        AND (f."activationMode" = 'ALWAYS_ENABLED' OR EXISTS (
          SELECT 1 FROM "billing"."ShopFeaturePreference" pref
          WHERE pref."shopId" = s."shopId" AND pref."featureId" = f."id" AND pref."enabled"
        ))
    ) AS "eligible"
  `);
  if (result[0]?.eligible !== true) throw conflict("checkout_recovery_unavailable");
}

/** Lock by authenticated merchant + exact E.164 recipient even on first insertion.
 * Hash collisions only cause extra serialisation, never cross-tenant access. */
async function lockConsentKey(tx: Tx, shopId: string, key: string): Promise<void> {
  await tx.$queryRaw<Array<{ locked: number }>>(Prisma.sql`
    SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(${shopId}), hashtext(${key}))
  `);
}

async function locatePhone(tx: Tx, shopId: string, digits: string): Promise<Phone | null> {
  const result = await tx.$queryRaw<Phone[]>(Prisma.sql`
    SELECT cp."id", cp."customerId", cp."whatsappCanonicalPhone",
      cp."whatsappConsentSource"::text AS "whatsappConsentSource",
      cp."whatsappConsentDecision"::text AS "whatsappConsentDecision",
      cp."whatsappConsentRevision", cp."whatsappConsentDecisionSequence",
      cp."whatsappConsentProviderObservedAt", cp."whatsappNoContact",
      cp."whatsappNoContactReason"::text AS "whatsappNoContactReason"
    FROM "commerce"."CustomerPhone" cp
    JOIN "commerce"."Customer" c ON c."id" = cp."customerId"
    WHERE c."shopId" = ${shopId} AND cp."endedAt" IS NULL
      AND (cp."whatsappCanonicalPhone" = ${digits} OR cp."phone" = ${`+${digits}`})
    ORDER BY cp."id" LIMIT 2 FOR UPDATE OF cp
  `);
  if (result.length > 1) throw conflict("ambiguous_customer_phone");
  const phone = result[0];
  if (phone?.whatsappCanonicalPhone && phone.whatsappCanonicalPhone !== digits) {
    throw conflict("recipient_mismatch");
  }
  if (phone?.whatsappConsentSource && phone.whatsappConsentSource !== "WOO_MODA_CHECKBOX") {
    throw conflict("consent_source_conflict");
  }
  return phone ?? null;
}

async function insertPhone(tx: Tx, shopId: string, digits: string, now: Date): Promise<Phone> {
  const customerId = randomUUID();
  const phoneId = randomUUID();
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "commerce"."Customer" ("id", "shopId", "phone", "createdAt", "updatedAt")
    VALUES (${customerId}, ${shopId}, ${`+${digits}`}, ${now}, ${now})
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "commerce"."CustomerPhone" ("id", "customerId", "phone", "whatsappCanonicalPhone",
      "whatsappPhoneVerifiedAt", "startedAt", "createdAt", "updatedAt")
    VALUES (${phoneId}, ${customerId}, ${`+${digits}`}, ${digits}, ${now}, ${now}, ${now}, ${now})
  `);
  return { id: phoneId, customerId, whatsappCanonicalPhone: digits,
    whatsappConsentSource: null, whatsappConsentDecision: "UNKNOWN",
    whatsappConsentRevision: 0n, whatsappConsentDecisionSequence: 0n,
    whatsappConsentProviderObservedAt: null, whatsappNoContact: false, whatsappNoContactReason: null };
}

/** No queue, outbox, checkout lookup, outbound message, billing or recovery model
 * is imported here. Consent is deliberately NOT a recovery work item. */
export class WooConsentService {
  constructor(private readonly database: Database, private readonly now: () => Date = () => new Date()) {}

  async record(principal: WooInstallationPrincipal, event: WooConsentEvent): Promise<WooConsentResult> {
    const normalized = normalizeRecipientPhone(event.checkoutAction.serverObservedPhone, {
      ...(event.checkoutAction.verifiedCountryCode
        ? { verifiedCountryCode: event.checkoutAction.verifiedCountryCode } : {}),
    });
    if (!normalized.ok || normalized.e164.slice(1) !== event.canonicalPhone) {
      throw new WooConsentHttpError(422, "recipient_mismatch");
    }
    const digest = createHash("sha256")
      .update(JSON.stringify({ installationId: principal.installationId, event }))
      .digest();
    try {
      return await this.database.$transaction(async tx => {
        await verifyInstallation(tx, principal);
        // Lock both the event identity and recipient before checking existing
        // evidence. Concurrent lost-ACK retries must not race to create revisions.
        await lockConsentKey(tx, principal.shopId, `event:${event.eventId}`);
        await lockConsentKey(tx, principal.shopId, `phone:${event.canonicalPhone}`);
        // The Shop and installation are locked before the evidence lookup.
        // An identical event remains idempotent even after feature disable or STOP.
        const existing = await tx.$queryRaw<Evidence[]>(Prisma.sql`
          SELECT "payloadDigest", "decision"::text AS "decision", "phoneConsentRevision", "decisionSequence"
          FROM "commerce"."WhatsAppConsentEvidence"
          WHERE "shopId" = ${principal.shopId} AND "eventId" = ${event.eventId} FOR SHARE
        `);
        if (existing.length) {
          const previous = existing[0]!;
          if (!Buffer.from(previous.payloadDigest).equals(digest)) throw conflict("consent_event_replay_conflict");
          return { schemaVersion: WOO_CONSENT_VERSION, status: "duplicate", decision: previous.decision,
            consentRevision: previous.phoneConsentRevision.toString(),
            decisionSequence: previous.decisionSequence.toString() };
        }
        if (event.decision === "GRANT") {
          if (!event.disclosure || event.disclosure.merchantSiteUrl !== principal.canonicalSiteUrl ||
            !event.disclosure.text.includes(principal.canonicalSiteUrl) ||
            !/WhatsApp/i.test(event.disclosure.text)) throw conflict("consent_disclosure_invalid");
          await requireRecoveryFeature(tx, principal.shopId);
        }
        const now = this.now();
        const occurred = new Date(event.checkoutAction.occurredAt);
        // Woo validates the action timestamp, then the API bounds clock skew and
        // insists that *accepted* decisions have increasing observed times.
        if (occurred.getTime() > now.getTime() ||
          (event.decision === "GRANT" && now.getTime() - occurred.getTime() > 300_000)) {
          throw conflict("stale_consent_action");
        }
        const phone = await locatePhone(tx, principal.shopId, event.canonicalPhone) ??
          await insertPhone(tx, principal.shopId, event.canonicalPhone, now);
        if (phone.whatsappConsentProviderObservedAt &&
          occurred <= phone.whatsappConsentProviderObservedAt) throw conflict("stale_consent_action");
        const revision = phone.whatsappConsentRevision + 1n;
        const sequence = phone.whatsappConsentDecisionSequence + 1n;
        const decision = event.decision === "GRANT" ? "GRANTED" : "REVOKED";
        // Do not touch whatsappNoContact / reason / revision / clearedAt.
        await tx.$executeRaw(Prisma.sql`
          UPDATE "commerce"."CustomerPhone" SET
            "whatsappCanonicalPhone" = ${event.canonicalPhone},
            "whatsappPhoneVerifiedAt" = ${now},
            "whatsappConsentDecision" = CAST(${decision} AS "commerce"."WhatsAppRecoveryConsentDecision"),
            "whatsappConsentSource" = 'WOO_MODA_CHECKBOX',
            "whatsappConsentProviderObservedAt" = ${occurred},
            "whatsappConsentVerifiedAt" = ${now},
            "whatsappConsentRevision" = ${revision},
            "whatsappConsentDecisionSequence" = ${sequence}, "updatedAt" = ${now}
          WHERE "id" = ${phone.id} AND "customerId" = ${phone.customerId} AND "endedAt" IS NULL
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "commerce"."WhatsAppConsentEvidence"
            ("id", "shopId", "installationId", "eventId", "payloadDigest", "customerId",
             "customerPhoneId", "canonicalPhone", "decision", "decisionSequence",
             "phoneConsentRevision", "decisionAt", "disclosureText", "disclosureVersion", "disclosureLocale")
          VALUES (${randomUUID()}, ${principal.shopId}, ${principal.installationId}, ${event.eventId}, ${digest},
            ${phone.customerId}, ${phone.id}, ${event.canonicalPhone},
            CAST(${event.decision} AS "commerce"."WhatsAppConsentEvidenceDecision"),
            ${sequence}, ${revision}, ${occurred}, ${event.disclosure?.text ?? null},
            ${event.disclosure?.version ?? null}, ${event.disclosure?.locale ?? null})
        `);
        return { schemaVersion: WOO_CONSENT_VERSION, status: "recorded", decision: event.decision,
          consentRevision: revision.toString(), decisionSequence: sequence.toString() };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034"].includes(error.code)) throw conflict("consent_write_conflict");
      throw error;
    }
  }
}
