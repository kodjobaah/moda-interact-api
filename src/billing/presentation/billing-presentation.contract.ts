// Stable v1 response and error identity shared by the reader, projector and routes.
export type ExperienceState = "ACTIVE" | "NO_CONTRACT" | "FROZEN" | "BILLING_ATTENTION";

export interface CapacityBalance {
  granted: number;
  committed: number;
  reserved: number;
  remaining: number;
}

export interface PaidIncludedBalance extends CapacityBalance {
  currentAllowance: number;
  forfeited: number;
}

export interface PurchasedBalance {
  granted: number;
  committed: number;
  reserved: number;
  refunding: number;
  available: number;
}

export interface PurchasePresentation {
  id: string;
  status: string;
  merchantPricingUsageEventId: string;
  label: string;
  creditsGranted: number;
  currentAmount: number;
  reservedAmount: number;
  createdAt: string;
  activatedAt: string | null;
  operationState: "INITIATING" | "AWAITING_CONFIRMATION" | "OUTCOME_UNKNOWN" | "CONFIRMED" | "FAILED";
}

export interface BillingPresentationResponse {
  schemaVersion: 1;
  experienceState: ExperienceState;
  surfaces: {
    usageHistoryAllowed: boolean;
    purchaseHistoryAllowed: boolean;
    managePlansAllowed: boolean;
    cancelSubscriptionAllowed: boolean;
  };
  currentPlan: null | {
    merchantPricingPlanId: string;
    displayName: string;
    planKind: "FREE" | "PAID_METERED";
    recurringAmountMinor: number;
    currency: string;
    billingPeriod: "EVERY_30_DAYS";
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    cancellationEffectiveAt: string | null;
  };
  pendingPlan: null | {
    merchantPricingPlanId: string;
    displayName: string;
    recurringAmountMinor: number;
    currency: string;
    billingPeriod: "EVERY_30_DAYS";
    state: "INITIATING" | "AWAITING_CONFIRMATION" | "OUTCOME_UNKNOWN";
  };
  pendingCancellation: null | {
    state: "INITIATING" | "AWAITING_CONFIRMATION" | "OUTCOME_UNKNOWN" | "CONFIRMED";
  };
  capacity: {
    paidIncluded: PaidIncludedBalance | null;
    freeLifetime: CapacityBalance;
    promotional: CapacityBalance;
    purchased: PurchasedBalance;
  };
  topUps: {
    configured: boolean;
    purchaseEligible: boolean;
    offers: Array<{
      merchantPricingUsageEventId: string;
      label: string;
      creditsGranted: number;
      amountMinor: number;
      currency: "USD";
      purchaseEligible: boolean;
      unavailableReason: "PENDING_PURCHASE" | null;
    }>;
    latestPurchase: PurchasePresentation | null;
    unresolvedPurchases: PurchasePresentation[];
  };
}

export class BillingPresentationError extends Error {
  constructor(readonly code:
    | "billing_not_initialized"
    | "billing_integrity_invalid"
    | "billing_catalogue_mapping_invalid"
    | "billing_operation_conflict"
  ) {
    super(code);
    this.name = "BillingPresentationError";
  }
}
