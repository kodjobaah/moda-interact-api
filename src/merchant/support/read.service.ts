import { Prisma } from "@prisma/client";
import { requiresMerchantTranslation } from "@modainteract/moda-interact-shared/merchant-communications";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { SupportIntegrityError, type SupportPage, type SupportQuery, type SupportMessage } from "./contract.js";
import { assertSupportInstallation, type SupportDatabase } from "./installation.js";

type Row = { id: string; kind: SupportMessage["kind"]; state: SupportMessage["state"];
  originalBody: string; sourceLanguageTag: string; displayLanguageTag: string | null;
  systemCode: string | null; systemVersion: string | null; translatedBody: string | null;
  translationStatus: "AVAILABLE" | null; createdAt: Date; readAt: Date | null;
  checkoutRecoveryId: string | null };
const VISIBLE = Prisma.sql`(m."kind" = 'MERCHANT' OR
  (m."kind" IN ('ADMINISTRATIVE', 'SYSTEM') AND m."state" = 'AVAILABLE'))`;
function safeCount(value: bigint) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new SupportIntegrityError();
  return count;
}
function safeCode(value: string | null, max: number): string | null {
  return value && value.length <= max && /^[A-Za-z0-9_.-]+$/.test(value) ? value : null;
}

/** Matches Shopify's ascending history, visibility, and translation display rules. */
export class MerchantSupportReadService {
  constructor(private readonly database: SupportDatabase) {}
  async read(principal: WooInstallationPrincipal, query: SupportQuery): Promise<SupportPage> {
    return this.database.$transaction(async tx => {
      await assertSupportInstallation(tx, principal, { write: false, allowSuspended: true });
      const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
        SELECT m."id",m."kind",m."state",m."originalBody",m."sourceLanguageTag",
          m."displayLanguageTag",m."systemCode",m."systemVersion",m."createdAt",m."readAt",
          CASE WHEN m."kind" = 'SYSTEM' AND m."state" = 'AVAILABLE'
            AND m."systemCode" = 'RECOVERY_INITIAL_OUTREACH_SENT' AND m."systemVersion" = '1'
            THEN r."id" ELSE NULL END AS "checkoutRecoveryId",
          tr."translatedBody",tr."status" AS "translationStatus"
        FROM "support"."MerchantSupportMessage" m
        INNER JOIN "support"."MerchantSupportThread" t ON t."id" = m."threadId"
        LEFT JOIN "commerce"."CheckoutRecovery" r
          ON r."id" = m."checkoutRecoveryId" AND r."shopId" = t."shopId"
        LEFT JOIN LATERAL (
          SELECT "translatedBody","status" FROM "support"."MerchantMessageTranslation"
          WHERE "messageId" = m."id" AND "targetLanguageTag" = m."displayLanguageTag"
            AND "status" = 'AVAILABLE' ORDER BY "createdAt" DESC LIMIT 1
        ) tr ON true
        WHERE t."shopId" = ${principal.shopId} AND ${VISIBLE}
        ORDER BY m."createdAt" ASC,m."id" ASC
        LIMIT ${query.pageSize} OFFSET ${(query.page-1)*query.pageSize}
      `);
      const counts = await tx.$queryRaw<Array<{ total: bigint; unread: bigint }>>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE ${VISIBLE})::bigint AS "total",
          COUNT(*) FILTER (WHERE m."kind" IN ('ADMINISTRATIVE','SYSTEM')
            AND m."state" = 'AVAILABLE' AND m."readAt" IS NULL)::bigint AS "unread"
        FROM "support"."MerchantSupportMessage" m
        INNER JOIN "support"."MerchantSupportThread" t ON t."id" = m."threadId"
        WHERE t."shopId" = ${principal.shopId}
      `);
      const total = safeCount(counts[0]?.total ?? 0n);
      return { schemaVersion: 2, page: query.page, pageSize: query.pageSize, total,
        totalPages: Math.max(1,Math.ceil(total/query.pageSize)), unread: safeCount(counts[0]?.unread ?? 0n),
        items: rows.map((row): SupportMessage => {
          const translationRequired = row.displayLanguageTag !== null &&
            requiresMerchantTranslation(row.sourceLanguageTag,row.displayLanguageTag);
          const available = translationRequired && row.translationStatus === "AVAILABLE" && row.translatedBody !== null;
          return { id: row.id, kind: row.kind, state: row.state,
            originalBody: !translationRequired || available ? row.originalBody : "",
            displayBody: translationRequired ? available ? row.translatedBody : null : row.originalBody,
            isTranslated: available, sourceLanguageTag: row.sourceLanguageTag,
            displayLanguageTag: row.displayLanguageTag,
            systemCode: row.kind === "SYSTEM" ? safeCode(row.systemCode,128) : null,
            systemVersion: row.kind === "SYSTEM" ? safeCode(row.systemVersion,64) : null,
            createdAt: row.createdAt.toISOString(), readAt: row.readAt?.toISOString() ?? null,
            checkoutRecoveryId: row.kind === "SYSTEM" && row.state === "AVAILABLE" &&
              row.systemCode === "RECOVERY_INITIAL_OUTREACH_SENT" && row.systemVersion === "1"
              ? row.checkoutRecoveryId : null };
        }) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
