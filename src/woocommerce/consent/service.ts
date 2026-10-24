import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { normalizeRecipientPhone } from "@modainteract/moda-interact-shared/identity";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { WooConsentHttpError,
  type WooConsentEvent, type WooConsentResult } from "./contract.js";

type Database = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;
type InstallationShop = { id: string; shopId: string; canonicalSiteUrl: string;
  installationStatus: string; credentialVersion: number; revokedAt: Date | null;
  domain: string; platform: string; shopStatus: string; shopifyShopId: string | null };
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
  // One indexed JOIN with share locks on *both* rows. PostgreSQL rechecks
  // current row versions after competing disconnect/rotation transactions.
  const rows = await tx.$queryRaw<InstallationShop[]>(Prisma.sql`
    SELECT i."id", i."shopId", i."canonicalSiteUrl",
      i."status"::text AS "installationStatus", i."credentialVersion", i."revokedAt",
      s."domain", s."platform"::text AS "platform",
      s."status"::text AS "shopStatus", s."shopifyShopId"
    FROM "commerce"."Shop" s
    JOIN "woocommerce"."WooCommerceInstallation" i ON i."shopId" = s."id"
    WHERE s."id" = ${principal.shopId} AND i."id" = ${principal.installationId}
    FOR SHARE OF s, i
  `);
  const row = rows[0];
  if (!row || row.shopId !== principal.shopId ||
    row.domain !== principal.canonicalSiteUrl || row.canonicalSiteUrl !== row.domain ||
    row.platform !== "WOOCOMMERCE" || row.shopifyShopId !== null || row.shopStatus !== "ACTIVE" ||
    row.credentialVersion !== principal.credentialVersion ||
    row.installationStatus !== "ACTIVE" || row.revokedAt !== null) throw new WooUnauthenticatedError();
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
    const normalized = normalizeRecipientPhone(`+${event.canonicalPhone}`);
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
          return { schemaVersion: event.schemaVersion, status: "duplicate", decision: previous.decision,
            consentRevision: previous.phoneConsentRevision.toString(),
            decisionSequence: previous.decisionSequence.toString() };
        }
        const now = this.now();
        const occurred = new Date(event.occurredAt);
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
        return { schemaVersion: event.schemaVersion, status: "recorded", decision: event.decision,
          consentRevision: revision.toString(), decisionSequence: sequence.toString() };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034"].includes(error.code)) throw conflict("consent_write_conflict");
      throw error;
    }
  }
}
