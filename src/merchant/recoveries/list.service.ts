import { Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { RecoveryListIntegrityError, type RecoveryListItem, type RecoveryListResponse } from "./contract.js";
import { parseRecoveryListQuery, resolveRecoveryTimeZone, type RecoveryListQuery } from "./query.js";

const recoverySelect = {
  id: true,
  status: true,
  detectedAt: true,
  lastExternalActivityAt: true,
  totalPrice: true,
  currency: true,
  customer: { select: { shopId: true, firstName: true, lastName: true, email: true } },
} as const satisfies Prisma.CheckoutRecoverySelect;

type RecoveryRow = Prisma.CheckoutRecoveryGetPayload<{ select: typeof recoverySelect }>;

function boundedText(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function project(row: RecoveryRow, shopId: string): RecoveryListItem {
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(row.id) ||
    (row.customer && row.customer.shopId !== shopId)) throw new RecoveryListIntegrityError();

  const name = row.customer
    ? [boundedText(row.customer.firstName, 80), boundedText(row.customer.lastName, 80)].filter(Boolean).join(" ")
    : "";
  const amount = row.totalPrice?.toString() ?? null;
  if (amount !== null && !/^-?\d{1,40}(?:\.\d{1,30})?$/.test(amount)) {
    throw new RecoveryListIntegrityError();
  }
  return {
    id: row.id,
    status: row.status,
    detectedAt: row.detectedAt.toISOString(),
    lastActivityAt: row.lastExternalActivityAt.toISOString(),
    totalPrice: amount,
    currency: row.currency && /^[A-Z]{3}$/.test(row.currency.trim()) ? row.currency.trim() : null,
    customer: row.customer
      ? { displayName: name ? name.slice(0, 160) : null, email: boundedText(row.customer.email, 320) }
      : null,
  };
}

function listWhere(shopId: string, query: RecoveryListQuery): Prisma.CheckoutRecoveryWhereInput {
  const where: Prisma.CheckoutRecoveryWhereInput = {
    shopId,
    detectedAt: { gte: query.start, lt: query.end },
  };
  if (query.status === "ongoing") {
    where.status = { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] };
  } else if (query.status !== "all") {
    where.status = query.status;
  }
  if (query.q) {
    // Every customer predicate includes the same authenticated Shop, even for a broken legacy FK.
    const terms: Prisma.CheckoutRecoveryWhereInput[] = query.q.split(/\s+/u).map((word) => ({
      customer: { is: { shopId, OR: [
        { firstName: { contains: word, mode: "insensitive" as const } },
        { lastName: { contains: word, mode: "insensitive" as const } },
        { email: { contains: word, mode: "insensitive" as const } },
      ] } },
    }));
    where.AND = terms;
  }
  return where;
}

/** One repeatable-read snapshot for the tenant check, exact count and requested page. */
export class MerchantRecoveryListService {
  constructor(
    private readonly database: Pick<PrismaClient, "$transaction">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(principal: WooInstallationPrincipal, params: URLSearchParams): Promise<RecoveryListResponse> {
    return this.database.$transaction(async (tx: Prisma.TransactionClient) => {
      const [shop, installation] = await Promise.all([
        tx.shop.findUnique({
          where: { id: principal.shopId },
          select: { id: true, domain: true, platform: true, shopifyShopId: true, status: true, defaultTimeZone: true },
        }),
        tx.wooCommerceInstallation.findUnique({
          where: { id: principal.installationId },
          select: { id: true, shopId: true, canonicalSiteUrl: true, status: true, revokedAt: true, credentialVersion: true },
        }),
      ]);
      if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
        shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE" ||
        !installation || installation.id !== principal.installationId ||
        installation.shopId !== principal.shopId || installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
        installation.status !== "ACTIVE" || installation.revokedAt !== null ||
        installation.credentialVersion !== principal.credentialVersion) {
        throw new RecoveryListIntegrityError();
      }

      const query = parseRecoveryListQuery(params, resolveRecoveryTimeZone(shop.defaultTimeZone), this.now());
      const where = listWhere(principal.shopId, query);
      const total = await tx.checkoutRecovery.count({ where });
      if (!Number.isSafeInteger(total) || total < 0) throw new RecoveryListIntegrityError();
      const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
      const page = Math.min(query.page, totalPages);
      const records = await tx.checkoutRecovery.findMany({
        where,
        orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * query.pageSize,
        take: query.pageSize,
        select: recoverySelect,
      });
      return {
        schemaVersion: 1,
        timeZone: query.timeZone,
        from: query.from,
        to: query.to,
        q: query.q,
        status: query.status,
        page,
        pageSize: query.pageSize,
        total,
        totalPages,
        hasPrevious: page > 1,
        hasNext: page < totalPages,
        items: records.map((record) => project(record, principal.shopId)),
      } satisfies RecoveryListResponse;
    }, { isolationLevel: "RepeatableRead" });
  }
}
