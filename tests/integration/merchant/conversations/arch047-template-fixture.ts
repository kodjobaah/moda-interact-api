import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

export const WABA = "123456789123";
export const NAME = "moda_follow_up_no_offer";
export const LANGUAGE = "en";
/** API's pinned Prisma schema predates ARCH-047: seed through the accepted SQL
 * columns, never mutate or fork the database submodule in this task.
 */
export async function createPublishedFollowUp(db: PrismaClient, shopId: string, now: Date,
  options: { wabaId?: string; name?: string; purpose?: string; linked?: boolean;
    providerStatus?: string; reconciledAt?: Date | null; enabled?: boolean } = {}) {
  const key = randomUUID();
  const wabaId = options.wabaId ?? WABA;
  const name = options.name ?? NAME;
  const purpose = options.purpose ?? "FOLLOW_UP_NO_OFFER";
  const offerType = purpose.slice("FOLLOW_UP_".length);
  const admin = await db.platformAdmin.create({ data: { email: `template-${key}@example.invalid`,
    role: "SUPER_ADMIN", active: true } });
  const definitionId = randomUUID(), localeId = randomUUID(), registrationId = randomUUID();
  const sourceHash = "a".repeat(64);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "whatsapp"."WhatsAppTemplateDefinition"
      ("id","kind","purpose","offerType","providerTemplateName","category",
       "sourceLanguageTag","astSchemaVersion","sourceHash","status","publishedAt","createdByAdminId")
    VALUES (${definitionId},'META_RECOVERY','FOLLOW_UP',${offerType},${name},'MARKETING',
      'en',1,${sourceHash},'PUBLISHED',${now},${admin.id})`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "whatsapp"."WhatsAppTemplateLocale"
      ("id","definitionId","languageTag","providerLanguageCode","status")
    VALUES (${localeId},${definitionId},'en','en','REVIEWED')`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "whatsapp"."WhatsAppTemplateMetaRegistration"
      ("id","localeId","wabaId","providerTemplateName","providerLanguageCode","category",
       "componentsSnapshot","parameterBindingsSnapshot","submittedContentHash",
       "providerTemplateId","submissionState","providerStatus","lastReconciledAt")
    VALUES (${registrationId},${localeId},${wabaId},${name},'en','MARKETING',
      '{}'::jsonb,'{}'::jsonb,${sourceHash},${key},'CONFIRMED',
      ${options.providerStatus ?? "APPROVED"},${options.reconciledAt === undefined ? now : options.reconciledAt})`);
  const variant = await db.whatsAppTemplateVariant.create({ data: {
    shopId, providerAccountId: wabaId, purpose, providerTemplateName: name,
    providerLanguageCode: LANGUAGE, providerTemplateId: key, languageTag: "en",
    enabled: options.enabled ?? true, status: "APPROVED",
  } });
  if (options.linked !== false) await db.$executeRaw(Prisma.sql`
    UPDATE "whatsapp"."WhatsAppTemplateVariant" SET "metaRegistrationId"=${registrationId}
    WHERE "id"=${variant.id} AND "shopId"=${shopId}`);
  return { variant, admin, definitionId, localeId, registrationId };
}
export const senderReader = { async readMessagingSenderWabaId() { return WABA; } };
