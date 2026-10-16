import { BillingOperationKind, BillingPlanKind, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { BillingSnapshotReader } from "./billing-snapshot.reader.js";
import { BillingPresentationError, type BillingPresentationResponse } from "./billing-presentation.contract.js";
import {
  projectBillingPresentation, validateBillingPeriod, validateCancellations, validateCore,
  validateCurrentCatalogue, validatePendingPlans, validateShop,
} from "./billing-projection.js";

// Retain the original exported API identity for all existing callers.
export { BillingPresentationError } from "./billing-presentation.contract.js";
export type { BillingPresentationResponse } from "./billing-presentation.contract.js";
export type BillingPresentationDatabase = Pick<PrismaClient, "$transaction">;

export class BillingPresentationReadService {
  constructor(private readonly database: BillingPresentationDatabase) {}

  async read(principal: WooInstallationPrincipal, now = new Date()): Promise<BillingPresentationResponse> {
    return this.database.$transaction(
      (transaction) => readBillingSnapshot(new BillingSnapshotReader(transaction, principal.shopId), principal, now),
      { isolationLevel: "RepeatableRead" },
    );
  }
}

async function readBillingSnapshot(
  reader: BillingSnapshotReader,
  principal: WooInstallationPrincipal,
  now: Date,
): Promise<BillingPresentationResponse> {
  const shop = await reader.readShop();
  validateShop(shop, principal);
  const core = await reader.readCore();
  validateCore(shop, core);
  const { subscription, recurringOperations } = core;

  const currentCataloguePlan = subscription?.plan
    ? await reader.readCurrentCataloguePlan(subscription.plan.shopifyPlanHandle)
    : null;
  validateCurrentCatalogue(subscription, currentCataloguePlan);

  const pendingOperation = recurringOperations.find((operation) =>
    operation.kind === BillingOperationKind.SUBSCRIPTION_CREATE || operation.kind === BillingOperationKind.PLAN_SWITCH,
  );
  const durablePendingPlan = subscription?.pendingPlanId ? subscription.pendingPlan : null;
  let operationTargetPlan: Awaited<ReturnType<BillingSnapshotReader["readCataloguePlanById"]>> = null;
  if (pendingOperation && !pendingOperation.merchantPricingPlanId) {
    throw new BillingPresentationError("billing_catalogue_mapping_invalid");
  }
  if (pendingOperation?.merchantPricingPlanId) {
    operationTargetPlan = await reader.readCataloguePlanById(pendingOperation.merchantPricingPlanId);
    if (!operationTargetPlan) throw new BillingPresentationError("billing_catalogue_mapping_invalid");
  }
  let durablePendingCataloguePlan: Awaited<ReturnType<BillingSnapshotReader["readCataloguePlanByHandle"]>> = null;
  if (durablePendingPlan) {
    durablePendingCataloguePlan = await reader.readCataloguePlanByHandle(durablePendingPlan.shopifyPlanHandle);
    if (!durablePendingCataloguePlan) throw new BillingPresentationError("billing_catalogue_mapping_invalid");
  }
  validatePendingPlans(subscription, recurringOperations, operationTargetPlan, durablePendingCataloguePlan);
  const validPaidPeriod = validateBillingPeriod(shop, subscription);

  let confirmedCancellation: Awaited<ReturnType<BillingSnapshotReader["readConfirmedCancellation"]>> | null = null;
  if (subscription?.providerSubscriptionId && subscription.plan?.kind === BillingPlanKind.PAID_METERED &&
      !subscription.cancelAtPeriodEnd) {
    confirmedCancellation = await reader.readConfirmedCancellation(subscription.providerSubscriptionId);
  }
  validateCancellations(subscription, recurringOperations, pendingOperation, confirmedCancellation);

  return projectBillingPresentation({
    shop, core, currentCataloguePlan, operationTargetPlan, durablePendingCataloguePlan,
    confirmedCancellation, validPaidPeriod,
  }, now);
}
