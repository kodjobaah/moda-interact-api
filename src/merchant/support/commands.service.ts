import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { canonicaliseLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import { PLATFORM_SUPPORT_LANGUAGE_TAG, requiresMerchantTranslation } from "@modainteract/moda-interact-shared/merchant-communications";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { SupportConflictError, SupportIntegrityError, SupportNotFoundError,
  type SupportComposeInput, type SupportComposeResponse, type SupportReadResponse } from "./contract.js";
import { assertSupportInstallation, type SupportDatabase } from "./installation.js";

export interface SupportTranslationDispatch { enqueue(translationId: string): Promise<void> }
export function supportSourceKey(shopId: string, actionId: string): string {
  return `woo-support:${createHash("sha256").update(shopId).update("\0").update(actionId).digest("hex")}`;
}
function language(value: string | null) {
  if (!value) return PLATFORM_SUPPORT_LANGUAGE_TAG;
  try { return canonicaliseLanguageTag(value); } catch { return PLATFORM_SUPPORT_LANGUAGE_TAG; }
}
type Previous = { id: string; kind: string; originalBody: string; translationId: string | null };

/** Shop-row serialization makes duplicate HTTP actions deterministic under races.
 * Translation dispatch is an optional hint, never a condition of message commit. */
export class MerchantSupportCommandService {
  constructor(private readonly database: SupportDatabase, private readonly translation: SupportTranslationDispatch,
    private readonly logger: StructuredLogger) {}
  async compose(principal: WooInstallationPrincipal, input: SupportComposeInput): Promise<{
    response: SupportComposeResponse; created: boolean;
  }> {
    const key = supportSourceKey(principal.shopId,input.actionId);
    const outcome = await this.database.$transaction(async tx => {
      const shop = await assertSupportInstallation(tx,principal,{write:true,allowSuspended:false});
      const existing = await tx.$queryRaw<Previous[]>(Prisma.sql`
        SELECT m."id",m."kind",m."originalBody",
          (SELECT tr."id" FROM "support"."MerchantMessageTranslation" tr
            WHERE tr."messageId"=m."id" AND tr."direction"='MERCHANT_TO_ADMIN'
            ORDER BY tr."createdAt" ASC LIMIT 1) AS "translationId"
        FROM "support"."MerchantSupportMessage" m
        INNER JOIN "support"."MerchantSupportThread" t ON t."id"=m."threadId"
        WHERE m."sourceKey"=${key} AND t."shopId"=${principal.shopId}
      `);
      if (existing[0]) {
        if (existing[0].kind !== "MERCHANT" || existing[0].originalBody !== input.body) throw new SupportConflictError();
        return { response: {schemaVersion:1 as const,messageId:existing[0].id,
          translationId:existing[0].translationId},created:false };
      }
      const now = new Date(), targetLanguage = language(shop.defaultLanguageTag);
      const needsTranslation = requiresMerchantTranslation(targetLanguage,PLATFORM_SUPPORT_LANGUAGE_TAG);
      const thread = await tx.$queryRaw<Array<{id:string}>>(Prisma.sql`
        INSERT INTO "support"."MerchantSupportThread" ("id","shopId","createdAt","updatedAt")
        VALUES (${randomUUID()},${principal.shopId},${now},${now})
        ON CONFLICT ("shopId") DO UPDATE SET "updatedAt"=${now} RETURNING "id"
      `);
      const threadId = thread[0]?.id;
      if (!threadId) throw new SupportIntegrityError();
      const messageId = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "support"."MerchantSupportMessage" (
          "id","threadId","kind","state","originalBody","sourceLanguageTag",
          "displayLanguageTag","shopifyUserId","sourceKey","availableAt","createdAt","updatedAt"
        ) VALUES (${messageId},${threadId},'MERCHANT','AVAILABLE',${input.body},
          ${targetLanguage},${targetLanguage},NULL,${key},${now},${now},${now})
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantSupportThread" SET
          "lastMessageAt"=${now},"lastMerchantMessageAt"=${now},
          "merchantMessageVersion"="merchantMessageVersion"+1,
          "needsAdminResponse"=true,"updatedAt"=${now}
        WHERE "id"=${threadId} AND "shopId"=${principal.shopId}
      `);
      let translationId: string | null = null;
      if (needsTranslation) {
        translationId=randomUUID();
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "support"."MerchantMessageTranslation" (
            "id","messageId","direction","sourceLanguageTag","targetLanguageTag",
            "status","createdAt","updatedAt"
          ) VALUES (${translationId},${messageId},'MERCHANT_TO_ADMIN',
            ${targetLanguage},${PLATFORM_SUPPORT_LANGUAGE_TAG},'PENDING',${now},${now})
        `);
      }
      return {response:{schemaVersion:1 as const,messageId,translationId},created:true};
    },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
    if (outcome.created && outcome.response.translationId) {
      try { await this.translation.enqueue(outcome.response.translationId); }
      catch (error) { this.logger.warn("merchant.support.translation_dispatch.deferred",{
        shopId:principal.shopId,reason:"queue_unavailable",
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        errorCause: error instanceof Error ? error.cause : undefined,
      }); }
    }
    return outcome;
  }

  /** Does not mutate readAt after the first successful mark, including retries. */
  async markRead(principal: WooInstallationPrincipal,messageId:string):Promise<SupportReadResponse> {
    return this.database.$transaction(async tx => {
      await assertSupportInstallation(tx,principal,{write:false,allowSuspended:true});
      const current = await tx.$queryRaw<Array<{readAt:Date|null}>>(Prisma.sql`
        SELECT m."readAt" FROM "support"."MerchantSupportMessage" m
        INNER JOIN "support"."MerchantSupportThread" t ON t."id"=m."threadId"
        WHERE t."shopId"=${principal.shopId} AND m."id"=${messageId}
          AND m."kind" IN ('ADMINISTRATIVE','SYSTEM') AND m."state"='AVAILABLE'
      `);
      if (!current[0]) throw new SupportNotFoundError();
      if (current[0].readAt) return {schemaVersion:1,messageId,readAt:current[0].readAt.toISOString()};
      const updated = await tx.$queryRaw<Array<{readAt:Date}>>(Prisma.sql`
        UPDATE "support"."MerchantSupportMessage" m SET "readAt"=NOW(),"updatedAt"=NOW()
        WHERE m."id"=${messageId} AND m."readAt" IS NULL
          AND m."kind" IN ('ADMINISTRATIVE','SYSTEM') AND m."state"='AVAILABLE'
          AND EXISTS (SELECT 1 FROM "support"."MerchantSupportThread" t
            WHERE t."id"=m."threadId" AND t."shopId"=${principal.shopId})
        RETURNING m."readAt"
      `);
      if (updated[0]) return {schemaVersion:1,messageId,readAt:updated[0].readAt.toISOString()};
      const reread = await tx.$queryRaw<Array<{readAt:Date|null}>>(Prisma.sql`
        SELECT m."readAt" FROM "support"."MerchantSupportMessage" m
        INNER JOIN "support"."MerchantSupportThread" t ON t."id"=m."threadId"
        WHERE t."shopId"=${principal.shopId} AND m."id"=${messageId}
          AND m."kind" IN ('ADMINISTRATIVE','SYSTEM') AND m."state"='AVAILABLE'
      `);
      if (!reread[0]?.readAt) throw new SupportIntegrityError();
      return {schemaVersion:1,messageId,readAt:reread[0].readAt.toISOString()};
    },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
  }
}
