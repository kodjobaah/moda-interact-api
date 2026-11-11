import { Prisma } from "@prisma/client";
import type { TransactionMessagingSenderFactory } from "../../../platform-configuration/composition.js";

export type SenderWabaReader = TransactionMessagingSenderFactory;
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

/** Bounded projection of canonical approval and frozen binding metadata.
 * Provider credentials are never included in the catalogue.
 */
export interface FollowUpRow {
  bindings?: unknown;
  components?: unknown;
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

/** Fail closed for ambiguous compatible presentation/greeting slots, even where one
 * registration appears valid. Collisions in externally visible name/language
 * are also suppressed. The confirmed first-message receipt selects the offer
 * presentation; the worker independently revalidates checkout eligibility.
 */
export function choicesFromRows(rows: readonly FollowUpRow[], shopId: string,
  senderWaba: string, now: Date, context?: { purpose: string; hasName: boolean }): FollowUpChoice[] {
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
    // Only a provider-confirmed receipt can select a positive-offer presentation.
    if (!slot.startsWith(`${context?.purpose ?? "FOLLOW_UP_NO_OFFER"}|`)) continue;
    const needsName = (row: FollowUpRow) => {
      const bindings = row.bindings as { header?: unknown; body?: unknown } | undefined;
      return [bindings?.header, bindings?.body].some(section => Array.isArray(section) &&
        section.some(binding => binding?.variable === "customer.firstName"));
    };
    const imageRows = group.filter(row => Array.isArray(row.components) &&
      row.components.some(component => component?.type === "HEADER" && component?.format === "IMAGE"));
    const presentation = imageRows.length ? imageRows : group;
    const named = presentation.filter(needsName);
    const candidates = context?.hasName && named.length ? named : presentation.filter(row => !needsName(row));
    if (candidates.length !== 1) continue;
    const row = candidates[0]!;
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
  sender: SenderWabaReader | undefined, now: Date, recoveryId?: string): Promise<FollowUpChoice[]> {
  // A missing or misconfigured sender must never permit a guessed provider WABA.
  if (!sender) return [];
  const senderWaba = await sender(tx).readMessagingSenderWabaId();
  if (!waba.test(senderWaba)) return [];
  let context: { purpose: string; hasName: boolean } | undefined;
  if (recoveryId) {
    const recovery = await tx.checkoutRecovery.findFirst({
      where: { id: recoveryId, shopId },
      select: { customer: { select: { firstName: true } },
        outreachAttempts: { where: { sequence: 1 }, select: { sentAt: true, outboundMessageId: true } } },
    });
    const initial = recovery?.outreachAttempts[0];
    if (!initial?.sentAt || !initial.outboundMessageId) return [];
    const message = await tx.conversationMessage.findUnique({ where: { id: initial.outboundMessageId },
      select: { content: true, status: true, providerMessageId: true, direction: true, senderType: true } });
    if (!message?.providerMessageId || !["SENT", "DELIVERED", "READ"].includes(message.status) ||
        message.direction !== "OUTBOUND" || message.senderType !== "AUTOMATION") return [];
    let receipt;
    try { receipt = JSON.parse(message.content); } catch { return []; }
    if (receipt?.contract !== "moda.whatsapp.automated-template-parameters.v1") return [];
    const promise = receipt.recoveryPromise;
    let offer = promise?.kind;
    if (offer === "CHECKOUT_DISCOUNT") {
      const offers = promise.offerSet?.offers;
      if (promise.offerSet?.schemaVersion !== "moda.outreach.checkout-offers.v1" ||
          !Array.isArray(offers) || offers.length !== 1) return [];
      offer = offers[0]?.method === "CODE" ? "CODE_OFFER" :
        offers[0]?.method === "AUTOMATIC" ? "AUTOMATIC_OFFER" : null;
    }
    if (!["NO_OFFER", "CODE_OFFER", "AUTOMATIC_OFFER"].includes(offer)) return [];
    context = { purpose: `FOLLOW_UP_${offer}`, hasName: Boolean(recovery?.customer?.firstName?.trim()) };
  }
  const rows = await tx.$queryRaw<FollowUpRow[]>(Prisma.sql`
    SELECT v."id" AS "variantId", v."shopId", v."providerAccountId", v."purpose",
      v."languageTag", v."providerTemplateName" AS "name",
      v."providerLanguageCode" AS "language", v."providerTemplateId" AS "variantProviderId",
      r."parameterBindingsSnapshot" AS "bindings", r."componentsSnapshot" AS "components", r."id" AS "registrationId", r."wabaId" AS "registrationWaba",
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
  return choicesFromRows(rows, shopId, senderWaba, now, context);
}

export function allowedFollowUpChoice(choices: readonly FollowUpChoice[],
  name: string, language: string): boolean {
  return choices.some((choice) => choice.name === name && choice.language === language);
}
