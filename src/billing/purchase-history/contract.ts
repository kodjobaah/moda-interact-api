/** Merchant-safe WooCommerce purchase history; provider IDs and refund commands are intentionally absent. */
export type PurchaseFilter = "ACTIVE" | "WITHDRAWN" | "COMPLETED" | "REFUNDED" | "ALL";
export type PageSize = 5 | 10 | 20;

export interface PurchaseHistoryQuery {
  filter: PurchaseFilter;
  page: number;
  pageSize: PageSize;
}

export interface RefundSummary {
  status: "REQUESTED" | "PROVIDER_ACTION_REQUIRED" | "COMPLETED" | "REJECTED" | "CANCELLED" | "NEEDS_ATTENTION";
  reason: string | null;
  finalCreditQuantity: number | null;
  providerAmount: { amount: string; currency: string } | null;
  createdAt: string;
  completedAt: string | null;
}

export interface PurchaseHistoryRow {
  id: string;
  status: "REQUESTED" | "ACTIVE" | "WITHDRAWN" | "COMPLETED" | "REFUNDED";
  createdAt: string;
  activatedAt: string | null;
  bundleLabel: string | null;
  planName: string;
  creditsGranted: number;
  currentAmount: number;
  reservedAmount: number;
  availableAmount: number;
  heldForRefundAmount: number;
  refundEligible: boolean;
  refundUnavailableReason:
    | "REFUND_ALREADY_ATTEMPTED" | "NO_AVAILABLE_CREDITS"
    | "PROVIDER_EVIDENCE_UNAVAILABLE" | "REFUND_IN_PROGRESS" | null;
  refundAttempted: boolean;
  latestRefund: RefundSummary | null;
  completedRefund: RefundSummary | null;
  originalProviderPurchase: { amount: string; currency: string } | null;
}

export interface PurchaseHistoryResponse {
  schemaVersion: 1;
  filter: PurchaseFilter;
  page: number;
  pageSize: PageSize;
  total: number;
  totalPages: number;
  purchases: PurchaseHistoryRow[];
  refundRequest: { method: "WOOCOMMERCE_ORDERS"; url: "https://woocommerce.com/my-account/orders/" };
}

export class PurchaseHistoryError extends Error {
  constructor(readonly code: "billing_integrity_invalid" | "billing_not_initialized") {
    super(code);
    this.name = "PurchaseHistoryError";
  }
}

export const WOO_ORDERS_REFUND_URL = "https://woocommerce.com/my-account/orders/" as const;
