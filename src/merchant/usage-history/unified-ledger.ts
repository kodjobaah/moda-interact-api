import { Prisma, type PrismaClient } from "@prisma/client";

export const CREDIT_SOURCES = [
  "ALL",
  "LIFETIME_FREE_CREDITS",
  "INCLUDED_PLAN_ALLOWANCE",
  "PURCHASED_TOP_UP",
  "PROMOTIONAL_CREDITS",
  "UNATTRIBUTED",
] as const;
export type CreditSource = (typeof CREDIT_SOURCES)[number];
export type ChargedAgainst = Exclude<CreditSource, "ALL">;
export type LedgerPeriod = { id: string; periodStart: Date; periodEnd: Date };
export type LedgerInput = {
  shopId: string;
  provider: "SHOPIFY" | "WOOCOMMERCE";
  source: CreditSource;
  page: number;
  pageSize: number;
  period: LedgerPeriod | null;
};
type LedgerRow = {
  id: string | null;
  metric: "RECOVERY_CONVERSATION" | null;
  quantity: Prisma.Decimal | null;
  occurredAt: Date | null;
  sourceId: string | null;
  correctionOfUsageEventId: string | null;
  billingPeriodId: string | null;
  chargedAgainst: ChargedAgainst | null;
  total: bigint;
  totalQuantity: Prisma.Decimal;
};

export function isCreditSource(value: unknown): value is CreditSource {
  return (
    typeof value === "string" &&
    CREDIT_SOURCES.some((source) => source === value)
  );
}

/** One statement for matching rows and signed totals. Classification is based
 * on the original debit's persisted, Shop-owned allocation, not its label or
 * the current plan. A malformed historical row remains visible as unattributed
 * when its original debit is valid; it cannot match a proven source.
 * Corrections use the original debit's period and funding, not their timestamp.
 */
export function unifiedLedgerQuery(input: LedgerInput): Prisma.Sql {
  const { shopId, provider, source, period, page, pageSize } = input;
  if (
    !isCreditSource(source) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    ![10, 25, 50, 100].includes(pageSize) ||
    (page - 1) * pageSize > 2147483647
  ) {
    throw new Error("Invalid unified usage filter");
  }
  const periodPredicate = period
    ? Prisma.sql`
    AND (o."billingPeriodId" = ${period.id} OR
      (o."billingPeriodId" IS NULL AND o."id" IS NOT NULL
       AND o."occurredAt" >= (${period.periodStart.toISOString()}::timestamptz AT TIME ZONE 'UTC')
       AND o."occurredAt" < (${period.periodEnd.toISOString()}::timestamptz AT TIME ZONE 'UTC')))`
    : Prisma.empty;
  const sourcePredicate =
    source === "ALL"
      ? Prisma.empty
      : Prisma.sql`WHERE "chargedAgainst" = ${source}`;
  return Prisma.sql`
    WITH classified AS (
      SELECT e."id", e."metric"::text AS "metric", e."quantity", e."occurredAt",
        e."sourceId", e."correctionOfUsageEventId", e."billingPeriodId",
        CASE
          WHEN u."id" IS NULL
            OR (e."correctionOfUsageEventId" IS NULL AND c."id" IS NOT NULL)
            OR (e."correctionOfUsageEventId" IS NOT NULL AND
                (own_reservation."id" IS NOT NULL OR (c."id" IS NOT NULL AND c."id" <> u."id")))
            THEN 'UNATTRIBUTED'
          WHEN pc."id" IS NOT NULL AND pc."counter" = 'INCLUDED_RECOVERY_CREDITS'
            AND pc."billingPeriodId" = o."billingPeriodId"
            AND u."counterId" IS NULL AND u."purchasedCreditPurchaseId" IS NULL
            AND u."promotionalCreditGrantId" IS NULL THEN 'INCLUDED_PLAN_ALLOWANCE'
          WHEN sc."counter" = 'PURCHASED_RECOVERY_CREDITS' AND purchase."id" IS NOT NULL
            AND u."billingPeriodEntitlementCounterId" IS NULL
            AND u."promotionalCreditGrantId" IS NULL THEN 'PURCHASED_TOP_UP'
          WHEN promotion."id" IS NOT NULL AND u."counterId" IS NULL
            AND u."billingPeriodEntitlementCounterId" IS NULL
            AND u."purchasedCreditPurchaseId" IS NULL THEN 'PROMOTIONAL_CREDITS'
          WHEN sc."counter" = 'LIFETIME_FREE_RECOVERY_CREDITS' AND o."billingPeriodId" IS NULL
            AND u."billingPeriodEntitlementCounterId" IS NULL
            AND u."purchasedCreditPurchaseId" IS NULL AND u."promotionalCreditGrantId" IS NULL
            THEN 'LIFETIME_FREE_CREDITS'
          ELSE 'UNATTRIBUTED' END AS "chargedAgainst"
      FROM billing."UsageEvent" e
      LEFT JOIN billing."UsageEvent" o ON o."id" = COALESCE(e."correctionOfUsageEventId", e."id")
        AND o."shopId" = e."shopId" AND o."provider" = e."provider"
        AND o."metric" = e."metric" AND o."correctionOfUsageEventId" IS NULL
      LEFT JOIN billing."UsageReservation" u ON u."committedUsageEventId" = o."id"
        AND u."shopId" = e."shopId" AND u."status" = 'COMMITTED'
      LEFT JOIN billing."UsageReservation" c ON c."compensationUsageEventId" = e."id"
      LEFT JOIN billing."UsageReservation" own_reservation ON own_reservation."committedUsageEventId" = e."id"
      LEFT JOIN billing."ShopEntitlementCounter" sc ON sc."id" = u."counterId" AND sc."shopId" = e."shopId"
      LEFT JOIN billing."BillingPeriodEntitlementCounter" pc ON pc."id" = u."billingPeriodEntitlementCounterId"
        AND pc."shopId" = e."shopId"
      LEFT JOIN billing."RecoveryCreditPurchase" purchase ON purchase."id" = u."purchasedCreditPurchaseId"
        AND purchase."shopId" = e."shopId"
      LEFT JOIN billing."PromotionalCreditGrant" promotion ON promotion."id" = u."promotionalCreditGrantId"
        AND promotion."shopId" = e."shopId"
      WHERE e."shopId" = ${shopId} AND e."provider" = ${provider}
        AND e."metric" = 'RECOVERY_CONVERSATION' AND o."id" IS NOT NULL ${periodPredicate}
    ), filtered AS (
      SELECT * FROM classified ${sourcePredicate}
    ), totals AS (
      SELECT count(*) AS "total", COALESCE(sum("quantity"), 0) AS "totalQuantity" FROM filtered
    ), page_rows AS (
      SELECT * FROM filtered ORDER BY "occurredAt" DESC, "id" DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    )
    SELECT page_rows.*, totals."total", totals."totalQuantity"
    FROM totals LEFT JOIN page_rows ON true
    ORDER BY page_rows."occurredAt" DESC, page_rows."id" DESC`;
}

export async function readUnifiedLedger(
  db: Pick<PrismaClient, "$queryRaw">,
  input: LedgerInput,
) {
  const rows = await db.$queryRaw<LedgerRow[]>(unifiedLedgerQuery(input));
  const head = rows[0];
  if (!head) throw new Error("Missing usage aggregate");
  const total = Number(head.total);
  const quantity = (value: Prisma.Decimal | null) => {
    const number = value === null ? 0 : Number(value);
    if (
      !Number.isSafeInteger(number) ||
      (value !== null && !new Prisma.Decimal(number).equals(value))
    )
      throw new Error("Invalid recovery credit quantity");
    return number;
  };
  if (!Number.isSafeInteger(total) || total < 0 || rows.length > input.pageSize)
    throw new Error("Invalid usage page aggregate");
  const events = rows.flatMap((row) => {
    if (row.id === null) return [];
    if (
      row.metric !== "RECOVERY_CONVERSATION" ||
      row.occurredAt === null ||
      row.chargedAgainst === null ||
      row.quantity === null ||
      !isCreditSource(row.chargedAgainst) ||
      String(row.chargedAgainst) === "ALL"
    )
      throw new Error("Invalid usage row");
    if (input.source !== "ALL" && row.chargedAgainst !== input.source)
      throw new Error("Invalid usage source");
    return [
      {
        id: row.id,
        metric: row.metric,
        quantity: quantity(row.quantity),
        occurredAt: row.occurredAt,
        sourceId: row.sourceId,
        billingPeriodId: row.billingPeriodId,
        correctionOfUsageEventId: row.correctionOfUsageEventId,
        chargedAgainst: row.chargedAgainst,
      },
    ];
  });
  if (events.length > total) throw new Error("Invalid usage page count");
  return { events, total, totalQuantity: quantity(head.totalQuantity) };
}
