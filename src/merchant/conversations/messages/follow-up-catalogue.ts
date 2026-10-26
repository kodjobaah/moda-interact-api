import { Prisma } from "@prisma/client";
import type { ApiPlatformConfigurationReader } from "../../../platform-configuration/service.js";

export type SenderWabaReader = Pick<ApiPlatformConfigurationReader, "readMessagingSenderWabaId">;
export type FollowUpChoice = Readonly<{ name: string; language: string }>;
export type FollowUpChoicesResponse = Readonly<{ schemaVersion: 1; templates: readonly FollowUpChoice[] }>;

const providerName = /^[a-z][a-z0-9_]{0,254}$/;
const providerLanguage = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
const waba = /^\d{4,32}$/;
const hash = /^[0-9a-f]{64}$/;
const PURPOSES = new Set(["FOLLOW_UP_NO_OFFER", "FOLLOW_UP_CODE_OFFER", "FOLLOW_UP_AUTOMATIC_OFFER"]);
const MAX_QUERY_ROWS = 300;
const MAX_PUBLIC_CHOICES = 30;
export const PROVIDER_APPROVAL_MAX_AGE_MS = 60 * 60_000;

/** A raw read is intentional: the API's pinned Prisma submodule predates the
 * accepted ARCH-047 migration. The query uses ONLY canonical ARCH-047 tables,
 * is bounded and never fetches components, customer data or provider secrets.
 */
export interface FollowUpRow {
  variantId: string; shopId: string; providerAccountId: string; purpose: string;
  languageTag: string; name: string; language: string; variantProviderId: string | null;
  registrationId: string | null; registrationWaba: string | null;
  registrationName: string | null; registrationLanguage: string | null;
  registrationProviderId: string | null; category: string | null;
  providerStatus: string | null; submissionState: string | null;
  failureCode: string | null; lastReconciledAt: Date | null;
  driftDetectedAt: Date | null; submittedHash: string | null;
  observedHash: string | null; observedCategory: string | null;
  localeTag: string | null; localeLanguage: string | null; localeStatus: string | null;
  definitionKind: string | null; definitionPurpose: string | null;
  definitionOffer: string | null; definitionStatus: string | null;
  definitionName: string | null; definitionCategory: string | null;
  publishedAt: Date | null; retiredAt: Date | null;
}

export function validFollowUpRow(row: FollowUpRow, shopId: string,
  senderWaba: string, now: Date): boolean {
  if (row.shopId !== shopId || !waba.test(senderWaba) ||
      row.providerAccountId !== senderWaba || row.registrationWaba !== senderWaba ||
      !PURPOSES.has(row.purpose) || !providerName.test(row.name) ||
      !providerLanguage.test(row.language) || !row.registrationId ||
      row.registrationName !== row.name || row.registrationLanguage !== row.language ||
      !row.variantProviderId || row.registrationProviderId !== row.variantProviderId ||
      row.localeLanguage !== row.language || row.localeTag !== row.languageTag ||
      row.localeStatus !== "REVIEWED" || row.definitionKind !== "META_RECOVERY" ||
      row.definitionPurpose !== "FOLLOW_UP" ||
      row.definitionOffer !== row.purpose.slice("FOLLOW_UP_".length) ||
      row.definitionStatus !== "PUBLISHED" || !row.publishedAt || row.retiredAt ||
      row.definitionName !== row.name || row.definitionCategory !== row.category ||
      row.providerStatus !== "APPROVED" ||
      !["SUBMITTED", "CONFIRMED", "APPROVED"].includes(row.submissionState ?? "") ||
      row.failureCode !== null || row.driftDetectedAt !== null ||
      !row.submittedHash || !hash.test(row.submittedHash) ||
      (row.observedHash !== null && row.observedHash !== row.submittedHash) ||
      (row.observedCategory !== null && row.observedCategory !== row.category)) return false;
  const reconciled = row.lastReconciledAt?.getTime();
  return reconciled !== undefined && Number.isFinite(reconciled) &&
    reconciled <= now.getTime() && now.getTime() - reconciled <= PROVIDER_APPROVAL_MAX_AGE_MS;
}

/** Fail closed for every ambiguous shop/purpose/language slot, even where one
 * registration appears valid. Collisions in externally visible name/language
 * are also suppressed. Positive offer choices require a separate verified,
 * customer-specific read port; it is NOT present for Woo in this snapshot.
 */
export function choicesFromRows(rows: readonly FollowUpRow[], shopId: string,
  senderWaba: string, now: Date): FollowUpChoice[] {
  if (rows.length > MAX_QUERY_ROWS) return [];
  const bySlot = new Map<string, FollowUpRow[]>();
  for (const row of rows) {
    if (row.shopId !== shopId || row.providerAccountId !== senderWaba || !PURPOSES.has(row.purpose)) return [];
    const key = `${row.purpose}|${row.languageTag}`;
    const group = bySlot.get(key) ?? [];
    group.push(row); bySlot.set(key, group);
  }
  const selected: FollowUpChoice[] = [];
  for (const [slot, group] of bySlot) {
    // Without checkout-specific verified offer evidence, fail closed to NO_OFFER.
    if (!slot.startsWith("FOLLOW_UP_NO_OFFER|") || group.length !== 1) continue;
    const row = group[0]!;
    if (validFollowUpRow(row, shopId, senderWaba, now)) {
      selected.push({ name: row.name, language: row.language });
    }
  }
  const counts = new Map<string, number>();
  for (const item of selected) {
    const key = `${item.name}|${item.language}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return selected.filter((item) => counts.get(`${item.name}|${item.language}`) === 1)
    .sort((a, b) => a.language.localeCompare(b.language, "en") || a.name.localeCompare(b.name, "en"))
    .slice(0, MAX_PUBLIC_CHOICES);
}

export async function readEligibleFollowUpChoices(tx: Prisma.TransactionClient, shopId: string,
  sender: SenderWabaReader | undefined, now: Date): Promise<FollowUpChoice[]> {
  // A missing or misconfigured sender must never permit a guessed provider WABA.
  if (!sender) return [];
  let senderWaba: string;
  try { senderWaba = await sender.readMessagingSenderWabaId(); }
  catch { return []; }
  if (!waba.test(senderWaba)) return [];
  const rows = await tx.$queryRaw<FollowUpRow[]>(Prisma.sql`
    SELECT v."id" AS "variantId", v."shopId", v."providerAccountId", v."purpose",
      v."languageTag", v."providerTemplateName" AS "name",
      v."providerLanguageCode" AS "language", v."providerTemplateId" AS "variantProviderId",
      r."id" AS "registrationId", r."wabaId" AS "registrationWaba",
      r."providerTemplateName" AS "registrationName",
      r."providerLanguageCode" AS "registrationLanguage",
      r."providerTemplateId" AS "registrationProviderId", r."category",
      r."providerStatus", r."submissionState", r."failureCode", r."lastReconciledAt",
      r."driftDetectedAt", r."submittedContentHash" AS "submittedHash",
      r."lastObservedContentHash" AS "observedHash",
      r."lastObservedCategory" AS "observedCategory",
      l."languageTag" AS "localeTag", l."providerLanguageCode" AS "localeLanguage",
      l."status" AS "localeStatus", d."kind" AS "definitionKind",
      d."purpose" AS "definitionPurpose", d."offerType" AS "definitionOffer",
      d."status" AS "definitionStatus", d."providerTemplateName" AS "definitionName",
      d."category" AS "definitionCategory", d."publishedAt", d."retiredAt"
    FROM "whatsapp"."WhatsAppTemplateVariant" v
    LEFT JOIN "whatsapp"."WhatsAppTemplateMetaRegistration" r ON r."id" = v."metaRegistrationId"
    LEFT JOIN "whatsapp"."WhatsAppTemplateLocale" l ON l."id" = r."localeId"
    LEFT JOIN "whatsapp"."WhatsAppTemplateDefinition" d ON d."id" = l."definitionId"
    WHERE v."shopId" = ${shopId} AND v."providerAccountId" = ${senderWaba}
      AND v."purpose" IN ('FOLLOW_UP_NO_OFFER','FOLLOW_UP_CODE_OFFER','FOLLOW_UP_AUTOMATIC_OFFER')
      AND v."enabled" = true AND v."status" = 'APPROVED'::"whatsapp"."WhatsAppTemplateStatus"
    ORDER BY v."purpose", v."languageTag", v."providerTemplateName", v."id"
    LIMIT ${MAX_QUERY_ROWS + 1}
  `);
  return choicesFromRows(rows, shopId, senderWaba, now);
}

export function allowedFollowUpChoice(choices: readonly FollowUpChoice[],
  name: string, language: string): boolean {
  return choices.some((choice) => choice.name === name && choice.language === language);
}
