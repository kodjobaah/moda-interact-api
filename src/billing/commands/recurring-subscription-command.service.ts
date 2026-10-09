import {
  BillingOperationKind,
  BillingOperationState,
  BillingPlanKind,
  MerchantPricingAllowancePeriod,
  MerchantPricingBillingPeriod,
  MerchantPricingPlanKind,
  Prisma,
  SubscriptionProjectionStatus,
  type BillingOperation,
  type BillingPlan,
  type MerchantPricingPlan,
  type PrismaClient,
} from "@prisma/client";
import { timingSafeEqual } from "node:crypto";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import {
  FreePlanConfigurationUnavailableError,
  InitialWooFreeActivationService,
  RetryFreeActivationTransactionError,
  type OperationalCataloguePlan,
} from "../../woocommerce/billing/initial-free-activation.service.js";
import { WooBillingClient, WooBillingProviderError, type WooSubscriptionRequest } from "../../woocommerce/billing/woo-billing-client.js";
import type { WooBillingConfig } from "../../woocommerce/billing/woo-billing-config.js";
import { createWooReturnUrl, formatUsdMinorUnits, recurringRequestFingerprint, type RecurringOperationKind } from "./recurring-command-primitives.js";

export type RecurringCommandResponse = {
  schemaVersion: 1;
  operationId: string;
  kind: RecurringOperationKind;
  state: "AWAITING_CONFIRMATION" | "CONFIRMED";
  confirmationUrl: string | null;
};

export class RecurringBillingCommandError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly operationId?: string,
    readonly safeProviderCode?: string,
  ) {
    super(code);
    this.name = "RecurringBillingCommandError";
  }
}

type BillingDatabase = Pick<PrismaClient, "$transaction">;
type ProviderClient = Pick<WooBillingClient, "createSubscription" | "switchSubscription" | "cancelSubscription">;
type MaterializedPlanResolver = Pick<InitialWooFreeActivationService, "resolvePaidPlan">;

interface LockedShop {
  id: string;
  domain: string;
  platform: string;
  shopifyShopId: string | null;
  status: string;
  onboardingCompleted: boolean;
}

interface CommandIntent {
  operation: BillingOperation;
  canonicalSiteUrl: string;
  targetPlan: Pick<MerchantPricingPlan, "displayName"> | null;
  replay: boolean;
}

interface OperationResult {
  operation: BillingOperation;
  error?: RecurringBillingCommandError;
}

export class RecurringSubscriptionCommandService {
  constructor(
    private readonly database: BillingDatabase,
    private readonly provider: ProviderClient,
    private readonly providerEnvironment: WooBillingConfig["environment"],
    private readonly planResolver: MaterializedPlanResolver = new InitialWooFreeActivationService(),
  ) {}

  async create(
    principal: WooInstallationPrincipal,
    requestKey: string,
    merchantPricingPlanId: string,
  ): Promise<RecurringCommandResponse> {
    return this.execute(principal, "SUBSCRIPTION_CREATE", requestKey, merchantPricingPlanId);
  }

  async switchPlan(
    principal: WooInstallationPrincipal,
    requestKey: string,
    merchantPricingPlanId: string,
  ): Promise<RecurringCommandResponse> {
    return this.execute(principal, "PLAN_SWITCH", requestKey, merchantPricingPlanId);
  }

  async cancel(principal: WooInstallationPrincipal, requestKey: string): Promise<RecurringCommandResponse> {
    return this.execute(principal, "CANCEL", requestKey);
  }

  private async execute(
    principal: WooInstallationPrincipal,
    kind: RecurringOperationKind,
    requestKey: string,
    merchantPricingPlanId?: string,
  ): Promise<RecurringCommandResponse> {
    const intent = await this.persistIntent(principal, kind, requestKey, merchantPricingPlanId);
    if (intent.replay) return replayOperation(intent.operation);

    let result: OperationResult;
    if (kind === "CANCEL") {
      try {
        await this.provider.cancelSubscription(intent.operation.providerReference!);
      } catch (error) {
        return this.failProviderOperation(intent.operation.id, error);
      }
      result = await this.updateOperationResult(intent.operation.id, {
        state: BillingOperationState.CONFIRMED,
        lastErrorCode: null,
      });
    } else {
      let providerEvidence: { id: string; confirmationUrl: string };
      try {
        const body: WooSubscriptionRequest = {
          name: intent.targetPlan!.displayName,
          price: formatUsdMinorUnits(intent.operation.quotedAmountMinor!),
          billing_period: "month",
          billing_interval: 1,
          return_url: createWooReturnUrl(intent.canonicalSiteUrl, intent.operation.id),
        };
        const response = kind === "SUBSCRIPTION_CREATE"
          ? await this.provider.createSubscription(body)
          : await this.provider.switchSubscription(intent.operation.providerReference!, body);
        providerEvidence = validateSubscriptionResponse(response, this.providerEnvironment);
        if (kind === "PLAN_SWITCH" && providerEvidence.id !== intent.operation.providerReference) {
          throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_CONTRACT_MISMATCH");
        }
      }
      catch (error) {
        return this.failProviderOperation(intent.operation.id, error);
      }
      result = await this.confirmSubscriptionOperation(intent.operation, providerEvidence);
    }
    if (result.error) throw result.error;
    return operationResponse(result.operation);
  }

  private async failProviderOperation(operationId: string, error: unknown): Promise<never> {
      const outcome = error instanceof WooBillingProviderError ? error.outcome : "OUTCOME_UNKNOWN";
      const safeCode = error instanceof WooBillingProviderError ? error.safeCode : "PROVIDER_RESPONSE_INVALID";
      const result = await this.updateOperationResult(operationId, {
        state: outcome === "DEFINITE_REJECTION" ? BillingOperationState.FAILED : BillingOperationState.OUTCOME_UNKNOWN,
        lastErrorCode: safeCode,
      });
      if (result.error) throw result.error;
      throw providerOutcomeError(result.operation);
  }

  private async persistIntent(
    principal: WooInstallationPrincipal,
    kind: RecurringOperationKind,
    requestKey: string,
    merchantPricingPlanId?: string,
    materializationRetry = 0,
  ): Promise<CommandIntent> {
    try {
      return await this.database.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
        `);
        const shop = await transaction.shop.findUnique({
          where: { id: principal.shopId },
          select: { id: true, domain: true, platform: true, shopifyShopId: true, status: true, onboardingCompleted: true },
        }) as LockedShop | null;
        if (
          !shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
          shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE"
        ) throw new RecurringBillingCommandError(409, "billing_shop_invalid");
        if (!shop.onboardingCompleted) throw new RecurringBillingCommandError(409, "billing_not_initialized");

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
            cancelAtPeriodEnd: true,
            providerSubscriptionId: true,
            plan: { select: { id: true, kind: true, shopifyPlanHandle: true, active: true } },
          },
        });

        const existing = await transaction.billingOperation.findUnique({
          where: { shopId_requestKey: { shopId: shop.id, requestKey } },
        });
        if (existing) {
          const replayCatalogue = kind === "CANCEL" || !merchantPricingPlanId
            ? null
            : await transaction.merchantPricingPlan.findUnique({ where: { id: merchantPricingPlanId } });
          return replayIntent(existing, kind, shop.domain, merchantPricingPlanId, replayCatalogue);
        }

        const operations = await transaction.billingOperation.findMany({
          where: {
            shopId: shop.id,
            kind: { in: [BillingOperationKind.SUBSCRIPTION_CREATE, BillingOperationKind.PLAN_SWITCH, BillingOperationKind.CANCEL] },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { kind: true, state: true, providerReference: true },
        });
        const hasUnresolvedOperation = operations.some((operation) =>
          operation.state === BillingOperationState.INITIATING ||
          operation.state === BillingOperationState.AWAITING_CONFIRMATION ||
          operation.state === BillingOperationState.OUTCOME_UNKNOWN,
        );
        const currentProviderReference = nonBlank(subscription?.providerSubscriptionId ?? null);
        const hasConfirmedCancellationForCurrentContract = operations.some((operation) =>
          operation.kind === BillingOperationKind.CANCEL && operation.state === BillingOperationState.CONFIRMED &&
          (subscription?.cancelAtPeriodEnd === true || !currentProviderReference ||
            operation.providerReference === currentProviderReference),
        );
        const canCreateAfterTerminalCancellation = kind === "SUBSCRIPTION_CREATE" &&
          subscription?.status === SubscriptionProjectionStatus.ACTIVE &&
          subscription?.plan?.kind === BillingPlanKind.FREE &&
          subscription.providerSubscriptionId === null &&
          subscription.billingPeriodId === null &&
          !subscription.cancelAtPeriodEnd;
        if (hasUnresolvedOperation ||
          (hasConfirmedCancellationForCurrentContract && !canCreateAfterTerminalCancellation)) {
          throw new RecurringBillingCommandError(409, "billing_operation_conflict");
        }
        if (!subscription?.plan || subscription.planId !== subscription.plan.id) {
          throw new RecurringBillingCommandError(409, "billing_subscription_invalid");
        }

        let target: MerchantPricingPlan | null = null;
        let targetOperationalPlan: BillingPlan | null = null;
        if (kind !== "CANCEL") {
          if (!merchantPricingPlanId) throw new RecurringBillingCommandError(400, "invalid_request");
          target = await transaction.merchantPricingPlan.findUnique({
            where: { id: merchantPricingPlanId },
            include: { features: { include: { feature: true } } },
          });
          if (target?.planKind === MerchantPricingPlanKind.FREE) {
            throw new RecurringBillingCommandError(409, "free_plan_uses_cancellation");
          }
          if (!target || !isSelectablePaidPlan(target)) {
            throw new RecurringBillingCommandError(409, "billing_plan_unavailable");
          }
        }

        const providerReference = nonBlank(subscription.providerSubscriptionId);
        if (kind === "SUBSCRIPTION_CREATE") {
          if (
            subscription.status !== SubscriptionProjectionStatus.ACTIVE || subscription.plan.kind !== BillingPlanKind.FREE ||
            subscription.providerSubscriptionId !== null || subscription.billingPeriodId !== null
          ) throw new RecurringBillingCommandError(409, "subscription_create_not_allowed");
        } else if (kind === "PLAN_SWITCH") {
          if (
            (subscription.status !== SubscriptionProjectionStatus.ACTIVE &&
              subscription.status !== SubscriptionProjectionStatus.TRIALING) ||
            subscription.plan.kind !== BillingPlanKind.PAID_METERED || !providerReference || subscription.cancelAtPeriodEnd
          ) throw new RecurringBillingCommandError(409, "subscription_switch_not_allowed");
          const currentCataloguePlan = await transaction.merchantPricingPlan.findUnique({
            where: { shopifyPlanHandle: subscription.plan.shopifyPlanHandle },
            select: { id: true },
          });
          if (!currentCataloguePlan) throw new RecurringBillingCommandError(409, "billing_catalogue_mapping_invalid");
          if (currentCataloguePlan.id === target!.id) throw new RecurringBillingCommandError(409, "billing_plan_unchanged");
        } else if (
          !providerReference || subscription.cancelAtPeriodEnd ||
          (subscription.status !== SubscriptionProjectionStatus.ACTIVE &&
            subscription.status !== SubscriptionProjectionStatus.TRIALING &&
            subscription.status !== SubscriptionProjectionStatus.FROZEN) ||
          subscription.plan.kind !== BillingPlanKind.PAID_METERED
        ) throw new RecurringBillingCommandError(409, "no_recurring_subscription");

        if (target) {
          targetOperationalPlan = await this.planResolver.resolvePaidPlan(transaction, target as OperationalCataloguePlan);
        }
        if (target && (!targetOperationalPlan || targetOperationalPlan.kind !== BillingPlanKind.PAID_METERED)) {
          throw new RecurringBillingCommandError(409, "billing_plan_materialization_invalid");
        }
        const fingerprint = recurringRequestFingerprint({
          kind,
          shopId: shop.id,
          ...(kind === "CANCEL" ? { providerReference: providerReference! } : {
            ...(kind === "PLAN_SWITCH" ? { providerReference: providerReference! } : {}),
            merchantPricingPlanId: target!.id,
            quotedAmountMinor: target!.recurringAmountMinor,
            quotedCurrency: target!.currency,
            quotedBillingPeriod: target!.billingPeriod,
          }),
        });
        const operation = await transaction.billingOperation.create({
          data: {
            shopId: shop.id,
            kind: operationKind(kind),
            state: BillingOperationState.INITIATING,
            requestKey,
            requestFingerprint: new Uint8Array(fingerprint),
            ...(target ? {
              merchantPricingPlanId: target.id,
              quotedAmountMinor: target.recurringAmountMinor,
              quotedCurrency: target.currency,
              quotedBillingPeriod: target.billingPeriod,
            } : {}),
            ...(kind !== "SUBSCRIPTION_CREATE" ? { providerReference: providerReference! } : {}),
          },
        });
        return { operation, canonicalSiteUrl: shop.domain, targetPlan: target, replay: false };
      }, { isolationLevel: "ReadCommitted" });
    } catch (error) {
      if (error instanceof RecurringBillingCommandError) throw error;
      if (error instanceof FreePlanConfigurationUnavailableError) {
        throw new RecurringBillingCommandError(409, "billing_plan_materialization_invalid");
      }
      if (error instanceof RetryFreeActivationTransactionError) {
        if (materializationRetry === 0) {
          return this.persistIntent(principal, kind, requestKey, merchantPricingPlanId, 1);
        }
        throw new RecurringBillingCommandError(409, "billing_plan_materialization_conflict");
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new RecurringBillingCommandError(409, "billing_operation_conflict");
      }
      throw error;
    }
  }

  private async confirmSubscriptionOperation(
    operation: BillingOperation,
    evidence: { id: string; confirmationUrl: string },
  ): Promise<OperationResult> {
    if (operation.kind === BillingOperationKind.SUBSCRIPTION_CREATE) {
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
          if (changed.count === 1) {
            const current = await requiredOperation(transaction, operation.id);
            return {
              operation: current,
              error: new RecurringBillingCommandError(502, "billing_provider_outcome_unknown", operation.id, current.lastErrorCode ?? undefined),
            };
          }
          return readOperationResult(transaction, operation.id);
        }
        const changed = await transaction.billingOperation.updateMany({
          where: { id: operation.id, state: BillingOperationState.INITIATING, providerReference: null },
          data: {
            state: BillingOperationState.AWAITING_CONFIRMATION,
            providerReference: evidence.id,
            confirmationUrl: evidence.confirmationUrl,
            lastErrorCode: null,
          },
        });
        return changed.count === 1
          ? { operation: await requiredOperation(transaction, operation.id) }
          : readOperationResult(transaction, operation.id);
      });
    }
    if (evidence.id !== operation.providerReference) {
      return this.updateOperationResult(operation.id, {
        state: BillingOperationState.OUTCOME_UNKNOWN,
        lastErrorCode: "PROVIDER_CONTRACT_MISMATCH",
      });
    }
    return this.updateOperationResult(operation.id, {
      state: BillingOperationState.AWAITING_CONFIRMATION,
      confirmationUrl: evidence.confirmationUrl,
      lastErrorCode: null,
    });
  }

  private async updateOperationResult(
    operationId: string,
    data: { state: BillingOperationState; confirmationUrl?: string; lastErrorCode: string | null },
  ): Promise<OperationResult> {
    return this.database.$transaction(async (transaction) => {
      const changed = await transaction.billingOperation.updateMany({
        where: { id: operationId, state: BillingOperationState.INITIATING },
        data,
      });
      return changed.count === 1
        ? { operation: await requiredOperation(transaction, operationId) }
        : readOperationResult(transaction, operationId);
    });
  }
}

async function requiredOperation(transaction: Prisma.TransactionClient, id: string): Promise<BillingOperation> {
  const operation = await transaction.billingOperation.findUnique({ where: { id } });
  if (!operation) throw new RecurringBillingCommandError(500, "internal_error");
  return operation;
}

async function readOperationResult(
  transaction: Prisma.TransactionClient,
  id: string,
  staleError?: RecurringBillingCommandError,
): Promise<OperationResult> {
  const operation = await requiredOperation(transaction, id);
  if (staleError) return { operation, error: staleError };
  return operation.state === BillingOperationState.AWAITING_CONFIRMATION || operation.state === BillingOperationState.CONFIRMED
    ? { operation }
    : { operation, error: operationStateError(operation) };
}

function replayIntent(
  operation: BillingOperation,
  kind: RecurringOperationKind,
  canonicalSiteUrl: string,
  merchantPricingPlanId?: string,
  catalogue?: MerchantPricingPlan | null,
): CommandIntent {
  if (
    operation.kind !== operationKind(kind) ||
    (kind !== "CANCEL" && operation.merchantPricingPlanId !== merchantPricingPlanId)
  ) throw new RecurringBillingCommandError(409, "idempotency_conflict", operation.id);
  if (kind !== "CANCEL" && (!catalogue || catalogue.id !== merchantPricingPlanId)) {
    throw new RecurringBillingCommandError(409, "idempotency_conflict", operation.id);
  }
  if (kind === "CANCEL" && !operation.providerReference) {
    throw new RecurringBillingCommandError(409, "idempotency_conflict", operation.id);
  }
  const fingerprint = recurringRequestFingerprint(kind === "CANCEL"
    ? { kind, shopId: operation.shopId, providerReference: operation.providerReference! }
    : {
        kind,
        shopId: operation.shopId,
        ...(kind === "PLAN_SWITCH" && operation.providerReference ? { providerReference: operation.providerReference } : {}),
        merchantPricingPlanId: catalogue!.id,
        quotedAmountMinor: catalogue!.recurringAmountMinor,
        quotedCurrency: catalogue!.currency,
        quotedBillingPeriod: catalogue!.billingPeriod,
      });
  const stored = Buffer.from(operation.requestFingerprint);
  if (stored.length !== fingerprint.length || !timingSafeEqual(stored, fingerprint)) {
    throw new RecurringBillingCommandError(409, "idempotency_conflict", operation.id);
  }
  return { operation, canonicalSiteUrl, targetPlan: null, replay: true };
}

function replayOperation(operation: BillingOperation): RecurringCommandResponse {
  if (operation.state !== BillingOperationState.AWAITING_CONFIRMATION && operation.state !== BillingOperationState.CONFIRMED) {
    if (operation.state === BillingOperationState.OUTCOME_UNKNOWN) {
      throw new RecurringBillingCommandError(409, "billing_provider_outcome_unknown", operation.id, operation.lastErrorCode ?? undefined);
    }
    throw operationStateError(operation);
  }
  return operationResponse(operation);
}

function operationStateError(operation: BillingOperation): RecurringBillingCommandError {
  if (operation.state === BillingOperationState.INITIATING) {
    return new RecurringBillingCommandError(409, "billing_operation_in_progress", operation.id);
  }
  if (operation.state === BillingOperationState.OUTCOME_UNKNOWN) {
    return new RecurringBillingCommandError(409, "billing_provider_outcome_unknown", operation.id, operation.lastErrorCode ?? undefined);
  }
  return new RecurringBillingCommandError(409, "billing_operation_failed", operation.id, operation.lastErrorCode ?? undefined);
}

function providerOutcomeError(operation: BillingOperation): RecurringBillingCommandError {
  return operation.state === BillingOperationState.FAILED
    ? new RecurringBillingCommandError(422, "billing_provider_rejected", operation.id, operation.lastErrorCode ?? undefined)
    : new RecurringBillingCommandError(502, "billing_provider_outcome_unknown", operation.id, operation.lastErrorCode ?? undefined);
}

function operationResponse(operation: BillingOperation): RecurringCommandResponse {
  if (operation.state !== BillingOperationState.AWAITING_CONFIRMATION && operation.state !== BillingOperationState.CONFIRMED) {
    throw operationStateError(operation);
  }
  const kind = publicOperationKind(operation.kind);
  if (!kind) throw new RecurringBillingCommandError(500, "internal_error");
  if (kind !== "CANCEL" && !operation.confirmationUrl) {
    throw new RecurringBillingCommandError(500, "internal_error");
  }
  return {
    schemaVersion: 1,
    operationId: operation.id,
    kind,
    state: operation.state,
    confirmationUrl: kind === "CANCEL" ? null : operation.confirmationUrl,
  };
}

function publicOperationKind(kind: BillingOperationKind): RecurringOperationKind | null {
  if (kind === BillingOperationKind.SUBSCRIPTION_CREATE) return "SUBSCRIPTION_CREATE";
  if (kind === BillingOperationKind.PLAN_SWITCH) return "PLAN_SWITCH";
  if (kind === BillingOperationKind.CANCEL) return "CANCEL";
  return null;
}

function operationKind(kind: RecurringOperationKind): BillingOperationKind {
  return kind as BillingOperationKind;
}

function isSelectablePaidPlan(plan: MerchantPricingPlan): boolean {
  return plan.isActive && plan.planKind === MerchantPricingPlanKind.PAID_METERED &&
    plan.allowancePeriod === MerchantPricingAllowancePeriod.EVERY_30_DAYS &&
    plan.billingPeriod === MerchantPricingBillingPeriod.EVERY_30_DAYS &&
    Number.isSafeInteger(plan.recurringAmountMinor) && plan.recurringAmountMinor > 0 &&
    plan.currency === "USD" && Number.isSafeInteger(plan.includedRecoveryCredits) && plan.includedRecoveryCredits >= 0;
}

function nonBlank(value: string | null): string | null {
  return typeof value === "string" && value.trim().length > 0 && !containsControlCharacters(value) ? value : null;
}

function validateSubscriptionResponse(
  value: unknown,
  environment: WooBillingConfig["environment"],
): { id: string; confirmationUrl: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID");
  }
  const response = value as Record<string, unknown>;
  if (
    typeof response.id !== "string" || !response.id.trim() || response.id.length > 255 ||
    containsControlCharacters(response.id)
  ) {
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
  return { id: response.id.trim(), confirmationUrl: confirmationUrl.toString() };
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}
