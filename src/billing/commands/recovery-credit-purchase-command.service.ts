import {
  BillingOperationKind,
  BillingOperationState,
  BillingPlanKind,
  MerchantPricingPlanKind,
  MerchantPricingUsagePricingMode,
  Prisma,
  SubscriptionProjectionStatus,
  type BillingOperation,
  type PrismaClient,
} from "@prisma/client";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import {
  WooBillingClient,
  WooBillingProviderError,
  type WooChargeRequest,
} from "../../woocommerce/billing/woo-billing-client.js";
import type { WooBillingConfig } from "../../woocommerce/billing/woo-billing-config.js";
import {
  createWooReturnUrl,
  formatUsdMinorUnits,
  recoveryCreditPurchaseFingerprint,
} from "./recurring-command-primitives.js";

export type RecoveryCreditPurchaseCommandResponse = {
  schemaVersion: 1;
  purchaseId: string;
  operationId: string;
  state: "AWAITING_CONFIRMATION" | "CONFIRMED";
  confirmationUrl: string;
};

export class RecoveryCreditPurchaseCommandError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly operationId?: string,
    readonly safeProviderCode?: string,
    readonly purchaseId?: string,
  ) {
    super(code);
    this.name = "RecoveryCreditPurchaseCommandError";
  }
}

type BillingDatabase = Pick<PrismaClient, "$transaction">;
type ProviderClient = Pick<WooBillingClient, "createCharge">;

interface CommandIntent {
  operation: BillingOperation;
  canonicalSiteUrl: string;
  bundleLabel: string;
  replay: boolean;
}

interface OperationResult {
  operation: BillingOperation;
  error?: RecoveryCreditPurchaseCommandError;
}

export class RecoveryCreditPurchaseCommandService {
  constructor(
    private readonly database: BillingDatabase,
    private readonly provider: ProviderClient,
    private readonly providerEnvironment: WooBillingConfig["environment"],
  ) {}

  async initiate(
    principal: WooInstallationPrincipal,
    requestKey: string,
    merchantPricingUsageEventId: string,
  ): Promise<RecoveryCreditPurchaseCommandResponse> {
    const intent = await this.persistIntent(principal, requestKey, merchantPricingUsageEventId);
    if (intent.replay) return replayOperation(intent.operation);

    const operation = intent.operation;
    let evidence: { id: string; confirmationUrl: string };
    try {
      const body: WooChargeRequest = {
        name: intent.bundleLabel,
        price: formatUsdMinorUnits(operation.quotedAmountMinor!),
        return_url: createWooReturnUrl(intent.canonicalSiteUrl, operation.id),
      };
      evidence = validateChargeResponse(
        await this.provider.createCharge(body),
        this.providerEnvironment,
      );
    } catch (error) {
      return this.failProviderOperation(operation, error);
    }

    const result = await this.confirmProviderOperation(operation, evidence);
    if (result.error) throw result.error;
    return operationResponse(result.operation);
  }

  private async persistIntent(
    principal: WooInstallationPrincipal,
    requestKey: string,
    merchantPricingUsageEventId: string,
  ): Promise<CommandIntent> {
    try {
      return await this.database.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
        `);
        const shop = await transaction.shop.findUnique({
          where: { id: principal.shopId },
          select: {
            id: true,
            domain: true,
            platform: true,
            shopifyShopId: true,
            status: true,
            onboardingCompleted: true,
          },
        });
        if (
          !shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
          shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE"
        ) throw new RecoveryCreditPurchaseCommandError(409, "billing_shop_invalid");
        if (!shop.onboardingCompleted) {
          throw new RecoveryCreditPurchaseCommandError(409, "billing_not_initialized");
        }

        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "billing"."Subscription" WHERE "shopId" = ${shop.id} FOR UPDATE
        `);
        const subscription = await transaction.subscription.findUnique({
          where: { shopId: shop.id },
          select: {
            id: true,
            shopId: true,
            planId: true,
            status: true,
            billingPeriodId: true,
            providerSubscriptionId: true,
            cancelAtPeriodEnd: true,
            plan: { select: { id: true, kind: true, shopifyPlanHandle: true, active: true } },
            billingPeriod: {
              select: { id: true, shopId: true, subscriptionId: true, planId: true, status: true },
            },
          },
        });

        const existing = await transaction.billingOperation.findUnique({
          where: { shopId_requestKey: { shopId: shop.id, requestKey } },
        });
        if (existing) {
          const replayBundle = await transaction.merchantPricingUsageEvent.findUnique({
            where: { id: merchantPricingUsageEventId },
            select: { id: true, fixedUnitAmountMinor: true, currency: true },
          });
          return replayIntent(existing, merchantPricingUsageEventId, shop.domain, replayBundle);
        }

        if (
          !subscription || subscription.shopId !== shop.id || !subscription.planId ||
          !subscription.plan || subscription.planId !== subscription.plan.id ||
          subscription.status !== SubscriptionProjectionStatus.ACTIVE || !subscription.plan.active
        ) throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_unavailable");

        const currentCataloguePlan = await transaction.merchantPricingPlan.findUnique({
          where: { shopifyPlanHandle: subscription.plan.shopifyPlanHandle },
          select: { id: true, planKind: true, isActive: true, currency: true },
        });
        if (
          !currentCataloguePlan || !currentCataloguePlan.isActive ||
          !cataloguePlanKindMatches(subscription.plan.kind, currentCataloguePlan.planKind)
        ) throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_unavailable");

        const bundle = await transaction.merchantPricingUsageEvent.findUnique({
          where: { id: merchantPricingUsageEventId },
          select: {
            id: true,
            merchantPricingPlanId: true,
            adminLabel: true,
            creditsGrantedPerUnit: true,
            pricingMode: true,
            fixedUnitAmountMinor: true,
            currency: true,
          },
        });
        if (!bundle || bundle.merchantPricingPlanId !== currentCataloguePlan.id) {
          throw new RecoveryCreditPurchaseCommandError(404, "top_up_bundle_not_found");
        }
        if (
          bundle.pricingMode !== MerchantPricingUsagePricingMode.FIXED ||
          !isPositiveSafeInteger(bundle.fixedUnitAmountMinor) ||
          !isPositiveSafeInteger(bundle.creditsGrantedPerUnit) ||
          bundle.currency !== currentCataloguePlan.currency || bundle.currency !== "USD" ||
          typeof bundle.adminLabel !== "string" || bundle.adminLabel.trim().length === 0
        ) throw new RecoveryCreditPurchaseCommandError(409, "top_up_bundle_unavailable");

        let purchaseBillingPeriodId: string | null = null;
        let providerSubscriptionIdSnapshot: string | null = null;
        if (subscription.plan.kind === BillingPlanKind.FREE) {
          if (subscription.billingPeriodId !== null || subscription.providerSubscriptionId !== null) {
            throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_unavailable");
          }
        } else if (subscription.plan.kind === BillingPlanKind.PAID_METERED) {
          const providerReference = nonBlank(subscription.providerSubscriptionId);
          const period = subscription.billingPeriod;
          if (
            !providerReference || !subscription.billingPeriodId || !period ||
            period.id !== subscription.billingPeriodId || period.shopId !== shop.id ||
            period.subscriptionId !== subscription.id || period.planId !== subscription.plan.id ||
            period.status !== "OPEN"
          ) throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_unavailable");
          purchaseBillingPeriodId = period.id;
          providerSubscriptionIdSnapshot = providerReference;
        } else {
          throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_unavailable");
        }

        const pending = await transaction.billingOperation.findFirst({
          where: {
            shopId: shop.id,
            kind: BillingOperationKind.ONE_TIME_CHARGE,
            merchantPricingUsageEventId: bundle.id,
            state: {
              in: [
                BillingOperationState.INITIATING,
                BillingOperationState.AWAITING_CONFIRMATION,
                BillingOperationState.OUTCOME_UNKNOWN,
                BillingOperationState.CONFIRMED,
              ],
            },
            recoveryCreditPurchase: { is: { provider: "WOOCOMMERCE", status: "REQUESTED" } },
          },
          select: { id: true },
        });
        if (pending) throw new RecoveryCreditPurchaseCommandError(409, "top_up_purchase_pending");

        const fingerprint = recoveryCreditPurchaseFingerprint({
          shopId: shop.id,
          merchantPricingUsageEventId: bundle.id,
          quotedAmountMinor: bundle.fixedUnitAmountMinor,
          quotedCurrency: bundle.currency,
        });
        const purchaseId = randomUUID();
        const purchase = await transaction.recoveryCreditPurchase.create({
          data: {
            id: purchaseId,
            shopId: shop.id,
            planId: subscription.plan.id,
            billingPeriodId: purchaseBillingPeriodId,
            shopifyPlanHandleSnapshot: null,
            shopifyEventHandleSnapshot: null,
            provider: "WOOCOMMERCE",
            providerReference: null,
            providerSubscriptionIdSnapshot,
            providerUsageQuantityBeforeSnapshot: null,
            providerUsageCostBeforeSnapshot: null,
            providerUsageCostCurrencyBeforeSnapshot: null,
            providerUsageQuantityAfterSnapshot: null,
            providerUsageCostAfterSnapshot: null,
            providerUsageCostCurrencyAfterSnapshot: null,
            providerPurchaseAmount: null,
            providerPurchaseCurrency: null,
            providerValuationConfirmedAt: null,
            providerPriceSnapshot: Prisma.DbNull,
            creditsGranted: bundle.creditsGrantedPerUnit,
            currentAmount: 0,
            reservedAmount: 0,
            status: "REQUESTED",
            usageEventId: null,
          },
        });
        const operation = await transaction.billingOperation.create({
          data: {
            shopId: shop.id,
            kind: BillingOperationKind.ONE_TIME_CHARGE,
            state: BillingOperationState.INITIATING,
            requestKey,
            requestFingerprint: new Uint8Array(fingerprint),
            merchantPricingPlanId: null,
            merchantPricingUsageEventId: bundle.id,
            quotedAmountMinor: bundle.fixedUnitAmountMinor,
            quotedCurrency: bundle.currency,
            quotedBillingPeriod: null,
            recoveryCreditPurchaseId: purchase.id,
            providerReference: null,
            confirmationUrl: null,
            lastErrorCode: null,
          },
        });
        return { operation, canonicalSiteUrl: shop.domain, bundleLabel: bundle.adminLabel.trim(), replay: false };
      }, { isolationLevel: "ReadCommitted" });
    } catch (error) {
      if (error instanceof RecoveryCreditPurchaseCommandError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new RecoveryCreditPurchaseCommandError(409, "billing_operation_conflict");
      }
      throw error;
    }
  }

  private async failProviderOperation(
    operation: BillingOperation,
    error: unknown,
  ): Promise<RecoveryCreditPurchaseCommandResponse> {
    const outcome = error instanceof WooBillingProviderError ? error.outcome : "OUTCOME_UNKNOWN";
    const safeCode = error instanceof WooBillingProviderError ? error.safeCode : "PROVIDER_RESPONSE_INVALID";
    const result = await this.updateOperation(operation, {
      state: outcome === "DEFINITE_REJECTION" ? BillingOperationState.FAILED : BillingOperationState.OUTCOME_UNKNOWN,
      lastErrorCode: safeCode,
    });
    if (
      result.operation.state === BillingOperationState.AWAITING_CONFIRMATION ||
      result.operation.state === BillingOperationState.CONFIRMED
    ) return operationResponse(result.operation);
    if (result.operation.state === BillingOperationState.FAILED) {
      throw new RecoveryCreditPurchaseCommandError(
        422,
        "billing_provider_rejected",
        result.operation.id,
        result.operation.lastErrorCode ?? undefined,
        result.operation.recoveryCreditPurchaseId ?? undefined,
      );
    }
    if (result.operation.state === BillingOperationState.OUTCOME_UNKNOWN) {
      throw providerOutcomeError(result.operation);
    }
    if (result.error) throw result.error;
    throw providerOutcomeError(result.operation);
  }

  private async confirmProviderOperation(
    operation: BillingOperation,
    evidence: { id: string; confirmationUrl: string },
  ): Promise<OperationResult> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        WITH provider_reference_lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(hashtextextended(${evidence.id}, 0))
        )
        SELECT 1 FROM provider_reference_lock
      `);
      const collision = await transaction.billingOperation.findFirst({
        where: { providerReference: evidence.id, shopId: { not: operation.shopId } },
        select: { id: true },
      });
      if (collision) {
        const changed = await transaction.billingOperation.updateMany({
          where: { id: operation.id, state: BillingOperationState.INITIATING },
          data: { state: BillingOperationState.OUTCOME_UNKNOWN, lastErrorCode: "PROVIDER_CONTRACT_COLLISION" },
        });
        const current = await requiredOperation(transaction, operation.id);
        return changed.count === 1
          ? { operation: current, error: providerOutcomeError(current) }
          : operationResult(current);
      }
      const changed = await transaction.billingOperation.updateMany({
        where: {
          id: operation.id,
          state: BillingOperationState.INITIATING,
          providerReference: null,
          confirmationUrl: null,
        },
        data: {
          state: BillingOperationState.AWAITING_CONFIRMATION,
          providerReference: evidence.id,
          confirmationUrl: evidence.confirmationUrl,
          lastErrorCode: null,
        },
      });
      const current = await requiredOperation(transaction, operation.id);
      return changed.count === 1 ? { operation: current } : operationResult(current);
    });
  }

  private async updateOperation(
    operation: BillingOperation,
    data: { state: BillingOperationState; lastErrorCode: string | null },
  ): Promise<OperationResult> {
    return this.database.$transaction(async (transaction) => {
      await transaction.billingOperation.updateMany({
        where: { id: operation.id, state: BillingOperationState.INITIATING },
        data,
      });
      const current = await requiredOperation(transaction, operation.id);
      return operationResult(current);
    });
  }
}

async function requiredOperation(transaction: Prisma.TransactionClient, id: string): Promise<BillingOperation> {
  const operation = await transaction.billingOperation.findUnique({ where: { id } });
  if (!operation) throw new RecoveryCreditPurchaseCommandError(500, "internal_error");
  return operation;
}

function replayIntent(
  operation: BillingOperation,
  merchantPricingUsageEventId: string,
  canonicalSiteUrl: string,
  bundle: { id: string; fixedUnitAmountMinor: number | null; currency: string } | null,
): CommandIntent {
  if (
    operation.kind !== BillingOperationKind.ONE_TIME_CHARGE ||
    operation.merchantPricingUsageEventId !== merchantPricingUsageEventId ||
    !operation.recoveryCreditPurchaseId ||
    !bundle || bundle.id !== merchantPricingUsageEventId ||
    !isPositiveSafeInteger(bundle.fixedUnitAmountMinor) ||
    !bundle.currency
  ) throw new RecoveryCreditPurchaseCommandError(409, "idempotency_conflict", operation.id);
  const fingerprint = recoveryCreditPurchaseFingerprint({
    shopId: operation.shopId,
    merchantPricingUsageEventId,
    quotedAmountMinor: bundle.fixedUnitAmountMinor,
    quotedCurrency: bundle.currency,
  });
  const stored = Buffer.from(operation.requestFingerprint);
  if (stored.length !== fingerprint.length || !timingSafeEqual(stored, fingerprint)) {
    throw new RecoveryCreditPurchaseCommandError(409, "idempotency_conflict", operation.id);
  }
  return { operation, canonicalSiteUrl, bundleLabel: "", replay: true };
}

function replayOperation(operation: BillingOperation): RecoveryCreditPurchaseCommandResponse {
  if (operation.state === BillingOperationState.OUTCOME_UNKNOWN) {
    throw providerOutcomeError(operation, 409);
  }
  if (operation.state === BillingOperationState.INITIATING) {
    throw new RecoveryCreditPurchaseCommandError(
      409, "billing_operation_in_progress", operation.id, undefined, operation.recoveryCreditPurchaseId ?? undefined,
    );
  }
  if (operation.state === BillingOperationState.FAILED) {
    throw new RecoveryCreditPurchaseCommandError(
      409, "billing_operation_failed", operation.id, operation.lastErrorCode ?? undefined,
      operation.recoveryCreditPurchaseId ?? undefined,
    );
  }
  return operationResponse(operation);
}

function operationResponse(operation: BillingOperation): RecoveryCreditPurchaseCommandResponse {
  if (
    (operation.state !== BillingOperationState.AWAITING_CONFIRMATION &&
      operation.state !== BillingOperationState.CONFIRMED) ||
    !operation.recoveryCreditPurchaseId || !operation.confirmationUrl
  ) throw operationStateError(operation);
  return {
    schemaVersion: 1,
    purchaseId: operation.recoveryCreditPurchaseId,
    operationId: operation.id,
    state: operation.state,
    confirmationUrl: operation.confirmationUrl,
  };
}

function operationResult(operation: BillingOperation): OperationResult {
  if (
    operation.state === BillingOperationState.AWAITING_CONFIRMATION ||
    operation.state === BillingOperationState.CONFIRMED
  ) return { operation };
  return { operation, error: operationStateError(operation) };
}

function operationStateError(operation: BillingOperation): RecoveryCreditPurchaseCommandError {
  const purchaseId = operation.recoveryCreditPurchaseId ?? undefined;
  if (operation.state === BillingOperationState.INITIATING) {
    return new RecoveryCreditPurchaseCommandError(409, "billing_operation_in_progress", operation.id, undefined, purchaseId);
  }
  if (operation.state === BillingOperationState.OUTCOME_UNKNOWN) return providerOutcomeError(operation, 409);
  return new RecoveryCreditPurchaseCommandError(
    409, "billing_operation_failed", operation.id, operation.lastErrorCode ?? undefined, purchaseId,
  );
}

function providerOutcomeError(
  operation: BillingOperation,
  statusCode = 502,
): RecoveryCreditPurchaseCommandError {
  return new RecoveryCreditPurchaseCommandError(
    statusCode,
    "billing_provider_outcome_unknown",
    operation.id,
    operation.lastErrorCode ?? undefined,
    operation.recoveryCreditPurchaseId ?? undefined,
  );
}

function cataloguePlanKindMatches(
  operationalKind: BillingPlanKind,
  catalogueKind: MerchantPricingPlanKind,
): boolean {
  return (operationalKind === BillingPlanKind.FREE && catalogueKind === MerchantPricingPlanKind.FREE) ||
    (operationalKind === BillingPlanKind.PAID_METERED && catalogueKind === MerchantPricingPlanKind.PAID_METERED);
}

function validateChargeResponse(
  value: unknown,
  environment: WooBillingConfig["environment"],
): { id: string; confirmationUrl: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID");
  }
  const response = value as Record<string, unknown>;
  const id = typeof response.id === "string" ? response.id.trim() : "";
  if (!UUID_PATTERN.test(id)) {
    throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID");
  }
  if (typeof response.confirmation_url !== "string" || response.confirmation_url.length > 2048) {
    throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID");
  }
  let confirmationUrl: URL;
  try {
    confirmationUrl = new URL(response.confirmation_url);
  } catch {
    throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID");
  }
  const expectedHost = environment === "sandbox" ? "sandbox.woocommerce.com" : "woocommerce.com";
  if (
    confirmationUrl.protocol !== "https:" || confirmationUrl.hostname !== expectedHost ||
    (confirmationUrl.port !== "" && confirmationUrl.port !== "443") ||
    confirmationUrl.username || confirmationUrl.password
  ) throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_REDIRECT_INVALID");
  return { id, confirmationUrl: confirmationUrl.toString() };
}

function isPositiveSafeInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function nonBlank(value: string | null): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;