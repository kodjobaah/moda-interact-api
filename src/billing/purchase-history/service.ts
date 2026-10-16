import type { Prisma, PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import {
  PurchaseHistoryError, WOO_ORDERS_REFUND_URL,
  type PurchaseHistoryQuery, type PurchaseHistoryResponse,
} from "./contract.js";
import { projectPurchase, purchaseHistorySelect } from "./projection.js";

/** All purchase rows and the count are read from the same repeatable-read snapshot. */
export class WooPurchaseHistoryReadService {
  constructor(private readonly database: Pick<PrismaClient, "$transaction">) {}

  async read(principal: WooInstallationPrincipal, query: PurchaseHistoryQuery): Promise<PurchaseHistoryResponse> {
    return this.database.$transaction(async (tx: Prisma.TransactionClient) => {
      const shop = await tx.shop.findUnique({
        where: { id: principal.shopId },
        select: { id: true, domain: true, platform: true, shopifyShopId: true, status: true, onboardingCompleted: true },
      });
      if (
        !shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
        shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE"
      ) throw new PurchaseHistoryError("billing_integrity_invalid");
      if (!shop.onboardingCompleted) throw new PurchaseHistoryError("billing_not_initialized");

      const where: Prisma.RecoveryCreditPurchaseWhereInput = {
        shopId: principal.shopId,
        provider: "WOOCOMMERCE",
        ...(query.filter === "ALL" ? {} : { status: query.filter }),
      };
      const total = await tx.recoveryCreditPurchase.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
      const page = Math.min(query.page, totalPages);
      const purchases = await tx.recoveryCreditPurchase.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * query.pageSize,
        take: query.pageSize,
        select: purchaseHistorySelect,
      });
      return {
        schemaVersion: 1,
        filter: query.filter,
        page,
        pageSize: query.pageSize,
        total,
        totalPages,
        purchases: purchases.map((purchase) => projectPurchase(purchase, principal.shopId)),
        refundRequest: { method: "WOOCOMMERCE_ORDERS", url: WOO_ORDERS_REFUND_URL },
      } satisfies PurchaseHistoryResponse;
    }, { isolationLevel: "RepeatableRead" });
  }
}
