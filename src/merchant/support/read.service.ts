import { Prisma } from "@prisma/client";
import { requiresMerchantTranslation } from "@modainteract/moda-interact-shared/merchant-communications";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { SupportIntegrityError, type SupportPage, type SupportQuery, type SupportMessage } from "./contract.js";
import { assertSupportInstallation, type SupportDatabase } from "./installation.js";

type Row = { id: string | null; kind: SupportMessage["kind"] | null; state: SupportMessage["state"] | null;
  originalBody: string; sourceLanguageTag: string; displayLanguageTag: string | null;
  systemCode: string | null; systemVersion: string | null; translatedBody: string | null;
  translationStatus: "AVAILABLE" | null; createdAt: Date; readAt: Date | null;
  checkoutRecoveryId: string | null; total: bigint; unread: bigint };
const VISIBLE_SCOPED = Prisma.sql`("kind" = 'MERCHANT' OR
  ("kind" IN ('ADMINISTRATIVE', 'SYSTEM') AND "state" = 'AVAILABLE'))`;
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
        WITH scoped AS MATERIALIZED (
          SELECT m."id",m."threadId",m."kind",m."state",m."originalBody",m."sourceLanguageTag",
            m."displayLanguageTag",m."systemCode",m."systemVersion",m."createdAt",m."readAt",
            m."checkoutRecoveryId"
          FROM "support"."MerchantSupportMessage" m
          INNER JOIN "support"."MerchantSupportThread" t ON t."id"=m."threadId"
          WHERE t."shopId"=${principal.shopId}
        ), aggregate AS (
          SELECT COUNT(*) FILTER (WHERE ${VISIBLE_SCOPED})::bigint AS total,
            COUNT(*) FILTER (WHERE "kind" IN ('ADMINISTRATIVE','SYSTEM')
              AND "state"='AVAILABLE' AND "readAt" IS NULL)::bigint AS unread
          FROM scoped
        ), page AS (
          SELECT scoped.* FROM scoped WHERE ${VISIBLE_SCOPED}
          ORDER BY "createdAt" ASC,"id" ASC LIMIT ${query.pageSize} OFFSET ${(query.page-1)*query.pageSize}
        )
        SELECT page."id",page."kind",page."state",page."originalBody",page."sourceLanguageTag",
          page."displayLanguageTag",page."systemCode",page."systemVersion",page."createdAt",page."readAt",
          CASE WHEN page."kind"='SYSTEM' AND page."state"='AVAILABLE'
            AND page."systemCode"='RECOVERY_INITIAL_OUTREACH_SENT' AND page."systemVersion"='1'
            THEN r."id" ELSE NULL END AS "checkoutRecoveryId",
          tr."translatedBody",tr."status" AS "translationStatus",aggregate.total,aggregate.unread
        FROM aggregate LEFT JOIN page ON true
        LEFT JOIN "support"."MerchantMessageTranslation" tr
          ON tr."messageId"=page."id" AND tr."targetLanguageTag"=page."displayLanguageTag"
          AND tr."status"='AVAILABLE'
        LEFT JOIN "support"."MerchantSupportThread" t ON t."id"=page."threadId"
        LEFT JOIN "commerce"."CheckoutRecovery" r
          ON r."id"=page."checkoutRecoveryId" AND r."shopId"=t."shopId"
        ORDER BY page."createdAt" ASC,page."id" ASC
      `);
      const total = safeCount(rows[0]?.total ?? 0n);
      return { schemaVersion: 2, page: query.page, pageSize: query.pageSize, total,
        totalPages: Math.max(1,Math.ceil(total/query.pageSize)), unread: safeCount(rows[0]?.unread ?? 0n),
        items: rows.flatMap((row): SupportMessage[] => {
          if (row.id === null || row.kind === null || row.state === null) return [];
          const translationRequired = row.displayLanguageTag !== null &&
            requiresMerchantTranslation(row.sourceLanguageTag,row.displayLanguageTag);
          const available = translationRequired && row.translationStatus === "AVAILABLE" && row.translatedBody !== null;
          return [{ id: row.id, kind: row.kind, state: row.state,
            originalBody: !translationRequired || available ? row.originalBody : "",
            displayBody: translationRequired ? available ? row.translatedBody : null : row.originalBody,
            isTranslated: available, sourceLanguageTag: row.sourceLanguageTag,
            displayLanguageTag: row.displayLanguageTag,
            systemCode: row.kind === "SYSTEM" ? safeCode(row.systemCode,128) : null,
            systemVersion: row.kind === "SYSTEM" ? safeCode(row.systemVersion,64) : null,
            createdAt: row.createdAt.toISOString(), readAt: row.readAt?.toISOString() ?? null,
            checkoutRecoveryId: row.kind === "SYSTEM" && row.state === "AVAILABLE" &&
              row.systemCode === "RECOVERY_INITIAL_OUTREACH_SENT" && row.systemVersion === "1"
              ? row.checkoutRecoveryId : null }];
        }) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
