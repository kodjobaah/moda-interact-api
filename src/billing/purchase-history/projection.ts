import type { Prisma } from "@prisma/client";
import type { PurchaseHistoryRow, RefundSummary } from "./contract.js";
import { PurchaseHistoryError } from "./contract.js";

export const purchaseHistorySelect = {
  id: true,
  status: true,
  createdAt: true,
  activatedAt: true,
  creditsGranted: true,
  currentAmount: true,
  reservedAmount: true,
  providerReference: true,
  providerValuationConfirmedAt: true,
  providerPurchaseAmount: true,
  providerPurchaseCurrency: true,
  refundAttemptedAt: true,
  plan: { select: { name: true } },
  billingOperation: {
    select: {
      shopId: true,
      recoveryCreditPurchaseId: true,
      kind: true,
      merchantPricingUsageEvent: { select: { adminLabel: true } },
    },
  },
  refunds: {
    where: { provider: "WOOCOMMERCE" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 11,
    select: {
      status: true,
      reason: true,
      finalCreditQuantity: true,
      providerAmount: true,
      providerCurrency: true,
      createdAt: true,
      completedAt: true,
    },
  },
} satisfies Prisma.RecoveryCreditPurchaseSelect;

export type HistoryPurchase = Prisma.RecoveryCreditPurchaseGetPayload<{ select: typeof purchaseHistorySelect }>;

type HistoryRefund = HistoryPurchase["refunds"][number];

function safeMoney(amount: { toString(): string } | null, currency: string | null): { amount: string; currency: string } | null {
  if (amount === null || !currency || !/^[A-Z]{3}$/.test(currency)) return null;
  const text = amount.toString();
  return /^\d{1,16}(?:\.\d{1,6})?$/.test(text) ? { amount: text, currency } : null;
}

function refundSummary(refund: HistoryRefund | undefined): RefundSummary | null {
  if (!refund) return null;
  return {
    status: refund.status,
    // Only bounded machine codes are merchant-safe; never reflect arbitrary operator notes.
    reason: refund.reason && /^[A-Z][A-Z0-9_]{0,63}$/.test(refund.reason) ? refund.reason : null,
    finalCreditQuantity: refund.finalCreditQuantity,
    providerAmount: safeMoney(refund.providerAmount, refund.providerCurrency),
    createdAt: refund.createdAt.toISOString(),
    completedAt: refund.completedAt?.toISOString() ?? null,
  };
}

export function projectPurchase(purchase: HistoryPurchase, shopId: string): PurchaseHistoryRow {
  const op = purchase.billingOperation;
  if (op && (op.shopId !== shopId || op.recoveryCreditPurchaseId !== purchase.id || op.kind !== "ONE_TIME_CHARGE")) {
    throw new PurchaseHistoryError("billing_integrity_invalid");
  }
  if (![purchase.creditsGranted, purchase.currentAmount, purchase.reservedAmount].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  ) || purchase.reservedAmount > purchase.currentAmount || purchase.refunds.length > 10) {
    throw new PurchaseHistoryError("billing_integrity_invalid");
  }

  const available = purchase.currentAmount - purchase.reservedAmount;
  const refundAttempted = purchase.refundAttemptedAt !== null;
  const evidence = Boolean(
    purchase.providerReference?.trim() && purchase.providerValuationConfirmedAt &&
    safeMoney(purchase.providerPurchaseAmount, purchase.providerPurchaseCurrency),
  );
  const latest = purchase.refunds[0];
  let refundUnavailableReason: PurchaseHistoryRow["refundUnavailableReason"] = null;
  if (refundAttempted) refundUnavailableReason = "REFUND_ALREADY_ATTEMPTED";
  else if (purchase.status === "WITHDRAWN" || latest) refundUnavailableReason = "REFUND_IN_PROGRESS";
  else if (purchase.status !== "ACTIVE" || available === 0) refundUnavailableReason = "NO_AVAILABLE_CREDITS";
  else if (!evidence) refundUnavailableReason = "PROVIDER_EVIDENCE_UNAVAILABLE";

  return {
    id: purchase.id,
    status: purchase.status,
    createdAt: purchase.createdAt.toISOString(),
    activatedAt: purchase.activatedAt?.toISOString() ?? null,
    bundleLabel: op?.merchantPricingUsageEvent?.adminLabel?.trim().slice(0, 120) || null,
    planName: purchase.plan.name.slice(0, 255),
    creditsGranted: purchase.creditsGranted,
    currentAmount: purchase.currentAmount,
    reservedAmount: purchase.reservedAmount,
    availableAmount: purchase.status === "ACTIVE" ? available : 0,
    heldForRefundAmount: purchase.status === "WITHDRAWN" ? available : 0,
    refundEligible: refundUnavailableReason === null,
    refundUnavailableReason,
    refundAttempted,
    latestRefund: refundSummary(latest),
    completedRefund: refundSummary(purchase.refunds.find((refund) => refund.status === "COMPLETED")),
    originalProviderPurchase: safeMoney(purchase.providerPurchaseAmount, purchase.providerPurchaseCurrency),
  };
}
