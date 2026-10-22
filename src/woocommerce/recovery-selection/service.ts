import { Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { assertSupportInstallation } from "../../merchant/support/installation.js";
import { WooRecoverySelectionError, WOO_RECOVERY_SELECTION_VERSION,
  type WooRecoverySelectionChange, type WooRecoverySelectionStatus,
  type WooRecoverySelectionWriteResult } from "./contract.js";

type Database = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;
type Phone = {
  id: string;
  whatsappCanonicalPhone: string;
  whatsappConsentDecision: "UNKNOWN" | "GRANTED" | "REVOKED";
  whatsappConsentSource: string | null;
  whatsappNoContact: boolean;
  whatsappNoContactReason: "MERCHANT_OPT_OUT" | "CUSTOMER_STOP" | null;
  whatsappNoContactRevision: bigint;
  whatsappNoContactAt: Date | null;
  whatsappNoContactClearedAt: Date | null;
};

const conflict = (reason: string) => new WooRecoverySelectionError(409, reason);

/** Same recipient-level serialization as WooConsentService and customer STOP.
 * Do not lock unrelated shops or globally serialize active merchants. */
async function lockRecipient(tx: Tx, shopId: string, canonicalPhone: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(
    hashtext(${shopId}), hashtext(${`phone:${canonicalPhone}`}))`);
}

async function locatePhone(tx: Tx, shopId: string, canonicalPhone: string): Promise<Phone> {
  const rows = await tx.$queryRaw<Phone[]>(Prisma.sql`
    SELECT cp."id", cp."whatsappCanonicalPhone",
      cp."whatsappConsentDecision"::text AS "whatsappConsentDecision",
      cp."whatsappConsentSource"::text AS "whatsappConsentSource",
      cp."whatsappNoContact", cp."whatsappNoContactReason"::text AS "whatsappNoContactReason",
      cp."whatsappNoContactRevision", cp."whatsappNoContactAt", cp."whatsappNoContactClearedAt"
    FROM "commerce"."CustomerPhone" cp
    INNER JOIN "commerce"."Customer" c ON c."id" = cp."customerId"
    WHERE c."shopId" = ${shopId} AND cp."endedAt" IS NULL
      AND (cp."whatsappCanonicalPhone" = ${canonicalPhone} OR cp."phone" = ${`+${canonicalPhone}`})
    ORDER BY cp."id" LIMIT 2 FOR UPDATE OF cp
  `);
  if (rows.length > 1) throw conflict("ambiguous_customer_phone");
  const phone = rows[0];
  if (!phone || phone.whatsappCanonicalPhone !== canonicalPhone) {
    throw new WooRecoverySelectionError(404, "customer_phone_not_found");
  }
  return phone;
}

function result(phone: Phone): WooRecoverySelectionStatus {
  const granted = phone.whatsappConsentDecision === "GRANTED" &&
    phone.whatsappConsentSource === "WOO_MODA_CHECKBOX";
  return {
    schemaVersion: WOO_RECOVERY_SELECTION_VERSION,
    consentDecision: phone.whatsappConsentDecision,
    suppressed: phone.whatsappNoContact,
    suppressionReason: phone.whatsappNoContactReason,
    noContactRevision: phone.whatsappNoContactRevision.toString(),
    phoneEligibleForRecovery: granted && !phone.whatsappNoContact,
    canReenable: granted && phone.whatsappNoContact && phone.whatsappNoContactReason === "MERCHANT_OPT_OUT",
  };
}

function desiredState(phone: Phone, command: WooRecoverySelectionChange): boolean {
  switch (command.action) {
    case "SUPPRESS":
      return phone.whatsappNoContact && phone.whatsappNoContactReason === "MERCHANT_OPT_OUT";
    case "REENABLE":
      return !phone.whatsappNoContact && phone.whatsappNoContactClearedAt !== null;
    case "RECORD_CUSTOMER_STOP":
      return phone.whatsappNoContact && phone.whatsappNoContactReason === "CUSTOMER_STOP";
  }
}

/** Uses CustomerPhone's existing no-contact revision as a compare-and-set token.
 * A repeated command never increments the revision; a command replayed AFTER a
 * later state transition is rejected rather than reversing a newer choice.
 * No Woo checkbox consent, evidence, queue, recovery or billing record is written. */
export class WooRecoverySelectionService {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  async read(principal: WooInstallationPrincipal, canonicalPhone: string): Promise<WooRecoverySelectionStatus> {
    return this.db.$transaction(async tx => {
      await assertSupportInstallation(tx, principal, { write: false, allowSuspended: false });
      await lockRecipient(tx, principal.shopId, canonicalPhone);
      return result(await locatePhone(tx, principal.shopId, canonicalPhone));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 });
  }

  async change(principal: WooInstallationPrincipal,
    command: WooRecoverySelectionChange): Promise<WooRecoverySelectionWriteResult> {
    try {
      return await this.db.$transaction(async tx => {
        await assertSupportInstallation(tx, principal, { write: false, allowSuspended: false });
        await lockRecipient(tx, principal.shopId, command.canonicalPhone);
        const phone = await locatePhone(tx, principal.shopId, command.canonicalPhone);
        const expected = BigInt(command.expectedNoContactRevision);
        const current = phone.whatsappNoContactRevision;
        // No stale command may operate on a changed CustomerPhone. Only the
        // immediately preceding identical state transition is retryable.
        if (expected !== current) {
          if (expected + 1n === current && desiredState(phone, command)) {
            return { ...result(phone), outcome: "duplicate" };
          }
          throw conflict("stale_no_contact_revision");
        }
        if (phone.whatsappNoContact && phone.whatsappNoContactReason === "CUSTOMER_STOP" &&
          command.action !== "RECORD_CUSTOMER_STOP") throw conflict("customer_stop_authoritative");
        if (command.action === "REENABLE" &&
          (phone.whatsappConsentDecision !== "GRANTED" ||
            phone.whatsappConsentSource !== "WOO_MODA_CHECKBOX")) throw conflict("customer_consent_required");
        if (desiredState(phone, command) || (command.action === "REENABLE" && !phone.whatsappNoContact)) {
          return { ...result(phone), outcome: "duplicate" };
        }
        const now = this.now();
        const stampedAt = new Date(Math.max(now.getTime(), (phone.whatsappNoContactAt?.getTime() ?? 0) + 1));
        if (command.action === "REENABLE") {
          if (phone.whatsappNoContactReason !== "MERCHANT_OPT_OUT") throw conflict("suppression_not_merchant_owned");
          await tx.$executeRaw(Prisma.sql`
            UPDATE "commerce"."CustomerPhone" SET "whatsappNoContact" = FALSE,
              "whatsappNoContactReason" = NULL,
              "whatsappNoContactClearedAt" = ${stampedAt},
              "whatsappNoContactRevision" = "whatsappNoContactRevision" + 1,
              "updatedAt" = ${stampedAt}
            WHERE "id" = ${phone.id} AND "endedAt" IS NULL
          `);
          phone.whatsappNoContact = false;
          phone.whatsappNoContactReason = null;
          phone.whatsappNoContactClearedAt = stampedAt;
        } else {
          const reason = command.action === "RECORD_CUSTOMER_STOP" ? "CUSTOMER_STOP" : "MERCHANT_OPT_OUT";
          await tx.$executeRaw(Prisma.sql`
            UPDATE "commerce"."CustomerPhone" SET "whatsappNoContact" = TRUE,
              "whatsappNoContactReason" = CAST(${reason} AS "commerce"."WhatsAppRecoveryNoContactReason"),
              "whatsappNoContactAt" = ${stampedAt},
              "whatsappNoContactRevision" = "whatsappNoContactRevision" + 1,
              "updatedAt" = ${stampedAt}
            WHERE "id" = ${phone.id} AND "endedAt" IS NULL
          `);
          phone.whatsappNoContact = true;
          phone.whatsappNoContactReason = reason;
          phone.whatsappNoContactAt = stampedAt;
        }
        phone.whatsappNoContactRevision = current + 1n;
        return { ...result(phone), outcome: "updated" };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034"].includes(error.code)) throw conflict("selection_write_conflict");
      throw error;
    }
  }
}
