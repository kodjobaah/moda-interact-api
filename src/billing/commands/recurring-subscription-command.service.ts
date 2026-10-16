import {
  BillingOperationKind,
  BillingOperationState,
  Prisma,
  type BillingOperation,
  type PrismaClient,
} from "@prisma/client";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { InitialWooFreeActivationService } from "../../woocommerce/billing/initial-free-activation.service.js";
import { WooBillingClient, WooBillingProviderError, type WooSubscriptionRequest } from "../../woocommerce/billing/woo-billing-client.js";
import type { WooBillingConfig } from "../../woocommerce/billing/woo-billing-config.js";
import { RecurringBillingCommandError } from "./recurring-command-error.js";
import { containsControlCharacters, createWooReturnUrl, formatUsdMinorUnits, type RecurringOperationKind } from "./recurring-command-primitives.js";
import { RecurringIntentPersistence, type MaterializedPlanResolver } from "./recurring-intent.js";

// Existing consumers continue to import the same error class from this file.
export { RecurringBillingCommandError } from "./recurring-command-error.js";

export type RecurringCommandResponse = {
  schemaVersion: 1;
  operationId: string;
  kind: RecurringOperationKind;
  state: "AWAITING_CONFIRMATION" | "CONFIRMED";
  confirmationUrl: string | null;
};

type BillingDatabase = Pick<PrismaClient, "$transaction">;
type ProviderClient = Pick<WooBillingClient, "createSubscription" | "switchSubscription" | "cancelSubscription">;

interface OperationResult {
  operation: BillingOperation;
  error?: RecurringBillingCommandError;
}

export class RecurringSubscriptionCommandService {
  private readonly intentPersistence: RecurringIntentPersistence;

  constructor(
    private readonly database: BillingDatabase,
    private readonly provider: ProviderClient,
    private readonly providerEnvironment: WooBillingConfig["environment"],
    planResolver: MaterializedPlanResolver = new InitialWooFreeActivationService(),
  ) {
    this.intentPersistence = new RecurringIntentPersistence(database, planResolver);
  }

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
    const intent = await this.intentPersistence.persistIntent(principal, kind, requestKey, merchantPricingPlanId);
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
