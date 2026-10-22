import { BillingPlanKind, Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import {
  UsageHistoryIntegrityError, UsageHistoryRequestError,
  type UsageHistoryQuery, type UsageHistoryResponse,
} from "./contract.js";
import { readPeriodPage, periodSelect, type PeriodRow } from "./periods.js";
import { readUsageRecoverySources } from "./sources.js";
import { readUsageChargeSources } from "./attribution.js";

const lifetimeSourceTypes = [
  "FREE_RECOVERY_RESERVATION", "PURCHASED_RECOVERY_CREDITS", "PROMOTIONAL_RECOVERY_CREDITS",
];
const pooledSourceTypes = ["PURCHASED_RECOVERY_CREDITS", "PROMOTIONAL_RECOVERY_CREDITS"];

const usageSelect = {
  id: true, metric: true, quantity: true, sourceId: true, occurredAt: true,
  billingPeriodId: true, correctionOfUsageEventId: true,
} as const satisfies Prisma.UsageEventSelect;

function quantity(value: Prisma.Decimal | null): number {
  const number = value === null ? 0 : value.toNumber();
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER ||
      (value !== null && !new Prisma.Decimal(number).equals(value))) {
    throw new UsageHistoryIntegrityError();
  }
  return number;
}

function periodValid(period: PeriodRow | null, subscription: {
  id: string; billingPeriodId: string | null;
  currentPeriodStart: Date | null; currentPeriodEnd: Date | null;
}, shopId: string, now: Date): period is PeriodRow {
  return !!period && period.shopId === shopId && period.subscriptionId === subscription.id &&
    period.id === subscription.billingPeriodId && period.status === "OPEN" &&
    period.planKindSnapshot === BillingPlanKind.PAID_METERED &&
    period.periodStart < period.periodEnd && period.periodStart <= now && period.periodEnd > now &&
    subscription.currentPeriodStart?.getTime() === period.periodStart.getTime() &&
    subscription.currentPeriodEnd?.getTime() === period.periodEnd.getTime();
}

/** Paid periods also include consumed purchased/promotional credits that have
 * no BillingPeriod FK, but were incurred within that Moda entitlement window.
 * Corrections follow their original event even if recorded after period close.
 */
export function usageWhere(shopId: string, query: UsageHistoryQuery, period: PeriodRow | null,
  freeLifetime: boolean): Prisma.UsageEventWhereInput {
  const base: Prisma.UsageEventWhereInput = {
    shopId, provider: "WOOCOMMERCE",
    ...(query.kind === "RECOVERY_CONVERSATION" ? { metric: "RECOVERY_CONVERSATION" } : {}),
  };
  if (freeLifetime) {
    return {
      ...base, billingPeriodId: null,
      OR: [
        { sourceType: { in: lifetimeSourceTypes } },
        { correctionOfUsageEvent: { is: {
          shopId, provider: "WOOCOMMERCE", billingPeriodId: null, sourceType: { in: lifetimeSourceTypes },
        } } },
      ],
    };
  }
  if (!period) throw new UsageHistoryIntegrityError();
  const window = { gte: period.periodStart, lt: period.periodEnd };
  return {
    ...base,
    OR: [
      { billingPeriodId: period.id },
      { billingPeriodId: null, sourceType: { in: pooledSourceTypes }, occurredAt: window },
      { billingPeriodId: null, correctionOfUsageEvent: { is: {
        shopId, provider: "WOOCOMMERCE",
        OR: [
          { billingPeriodId: period.id },
          { billingPeriodId: null, sourceType: { in: pooledSourceTypes }, occurredAt: window },
        ],
      } } },
    ],
  };
}

export class MerchantUsageHistoryService {
  constructor(private readonly database: Pick<PrismaClient, "$transaction">,
    private readonly now: () => Date = () => new Date()) {}

  async read(principal: WooInstallationPrincipal, query: UsageHistoryQuery): Promise<UsageHistoryResponse> {
    return this.database.$transaction(async (tx: Prisma.TransactionClient): Promise<UsageHistoryResponse> => {
      const [shop, installation, subscription] = await Promise.all([
        tx.shop.findUnique({ where: { id: principal.shopId }, select: {
          id: true, domain: true, platform: true, shopifyShopId: true, status: true, onboardingCompleted: true,
        } }),
        tx.wooCommerceInstallation.findUnique({ where: { id: principal.installationId }, select: {
          shopId: true, canonicalSiteUrl: true, credentialVersion: true, credentialDigest: true,
          revokedAt: true, status: true,
        } }),
        tx.subscription.findUnique({ where: { shopId: principal.shopId }, select: {
          id: true, shopId: true, billingPeriodId: true, currentPeriodStart: true, currentPeriodEnd: true,
          plan: { select: { kind: true } },
        } }),
      ]);
      if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
          shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE" ||
          !shop.onboardingCompleted || !installation || installation.shopId !== principal.shopId ||
          installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
          installation.credentialVersion !== principal.credentialVersion ||
          installation.status !== "ACTIVE" || installation.revokedAt !== null ||
          installation.credentialDigest.length !== 32 ||
          (subscription && subscription.shopId !== principal.shopId)) throw new UsageHistoryIntegrityError();

      const isFree = subscription?.plan?.kind === BillingPlanKind.FREE;
      const isPaid = subscription?.plan?.kind === BillingPlanKind.PAID_METERED;
      if (isFree && (subscription.billingPeriodId !== null ||
        subscription.currentPeriodStart !== null || subscription.currentPeriodEnd !== null)) {
        throw new UsageHistoryIntegrityError();
      }
      const now = this.now();
      const current = isPaid && subscription?.billingPeriodId
        ? await tx.billingPeriod.findFirst({
            where: { id: subscription.billingPeriodId, shopId: principal.shopId }, select: periodSelect,
          }) : null;
      const currentPeriod = isPaid && subscription && periodValid(current, subscription, principal.shopId, now)
        ? current : null;
      const periodPage = await readPeriodPage(tx, {
        shopId: principal.shopId, view: query.view, cursor: query.periodCursor,
        key: installation.credentialDigest, currentPeriod,
      });
      let selected: PeriodRow | null = null;
      if (query.periodId !== null) {
        if (query.view === "current") {
          if (query.periodId !== currentPeriod?.id) throw new UsageHistoryRequestError("invalid_period");
          selected = currentPeriod;
        } else {
          selected = await tx.billingPeriod.findFirst({
            where: { id: query.periodId, shopId: principal.shopId, status: "CLOSED" }, select: periodSelect,
          });
          if (!selected) throw new UsageHistoryRequestError("invalid_period");
        }
      } else if (query.view === "current") {
        selected = currentPeriod;
      } else {
        const first = periodPage.items[0];
        if (first) selected = await tx.billingPeriod.findFirst({
          where: { id: first.id, shopId: principal.shopId, status: "CLOSED" }, select: periodSelect,
        });
      }
      const freeLifetime = query.view === "current" && isFree;
      const available = freeLifetime || selected !== null;
      const empty = { page: query.page, pageSize: query.pageSize, total: 0, totalQuantity: 0,
        billId: null, periodStart: null, periodEnd: null };
      if (!available) {
        const common = { state: query.view === "current" ? "unavailable" as const : "ready" as const,
          usageView: query.view, periodPage, usageEvents: [], usagePagination: empty };
        return query.responseVersion === 2
          ? { schemaVersion: 2, ...common }
          : { schemaVersion: 1, ...common };
      }
      const where = usageWhere(principal.shopId, query, selected, freeLifetime);
      const [events, total, aggregated] = await Promise.all([
        tx.usageEvent.findMany({ where, select: usageSelect,
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        tx.usageEvent.count({ where }),
        tx.usageEvent.aggregate({ where, _sum: { quantity: true } }),
      ]);
      if (!Number.isSafeInteger(total) || total < 0) throw new UsageHistoryIntegrityError();
      const sources = await readUsageRecoverySources(tx, principal.shopId,
        events.flatMap((event) => event.sourceId ? [event.sourceId] : []));
      const chargedAgainst = query.responseVersion === 2
        ? await readUsageChargeSources(tx, principal.shopId, events) : null;
      const common = {
        state: "ready" as const, usageView: query.view, periodPage,
        usageEvents: events.map((event) => ({
          id: event.id, metric: event.metric, quantity: quantity(event.quantity),
          occurredAt: event.occurredAt.toISOString(),
          sourceRecovery: event.sourceId ? sources.get(event.sourceId) ?? null : null,
        })),
        usagePagination: {
          page: query.page, pageSize: query.pageSize, total, totalQuantity: quantity(aggregated._sum.quantity),
          billId: selected?.id ?? null,
          periodStart: selected?.periodStart.toISOString() ?? null,
          periodEnd: selected?.periodEnd.toISOString() ?? null,
        },
      };
      if (chargedAgainst) {
        return { ...common, schemaVersion: 2, usageEvents: common.usageEvents.map((event) => ({
          ...event, chargedAgainst: chargedAgainst.get(event.id) ?? "UNATTRIBUTED",
        })) } satisfies UsageHistoryResponse;
      }
      return { ...common, schemaVersion: 1 } satisfies UsageHistoryResponse;
    }, { isolationLevel: "RepeatableRead" });
  }
}
