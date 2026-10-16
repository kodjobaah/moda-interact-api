import {
  BillingOperationState,
  Prisma,
  type BillingOperation,
  type PrismaClient,
} from "@prisma/client";
import type { RecoveryCreditPurchaseCommandResponse } from "./recovery-credit-purchase-command.service.js";
import { RecoveryCreditPurchaseCommandError } from "./recovery-credit-command-error.js";
import { WooBillingProviderError } from "../../woocommerce/billing/woo-billing-client.js";
import type { WooBillingConfig } from "../../woocommerce/billing/woo-billing-config.js";

type BillingDatabase = Pick<PrismaClient, "$transaction">;

type ChargeEvidence = { id: string; confirmationUrl: string };

interface OperationResult {
  operation: BillingOperation;
  error?: RecoveryCreditPurchaseCommandError;
}

/** Persists only provider outcomes; the initiating intent is committed before this is called. */
export class RecoveryCreditOutcomePersistence {
  constructor(
    private readonly database: BillingDatabase,
    private readonly providerEnvironment: WooBillingConfig["environment"],
  ) {}

  validateChargeResponse(value: unknown): ChargeEvidence {
    return validateChargeResponse(value, this.providerEnvironment);
  }

  async failProviderOperation(operation: BillingOperation, error: unknown): Promise<BillingOperation> {
    const outcome = error instanceof WooBillingProviderError ? error.outcome : "OUTCOME_UNKNOWN";
    const safeCode = error instanceof WooBillingProviderError ? error.safeCode : "PROVIDER_RESPONSE_INVALID";
    const result = await this.updateOperation(operation, {
      state: outcome === "DEFINITE_REJECTION" ? BillingOperationState.FAILED : BillingOperationState.OUTCOME_UNKNOWN,
      lastErrorCode: safeCode,
    });
    if (
      result.operation.state === BillingOperationState.AWAITING_CONFIRMATION ||
      result.operation.state === BillingOperationState.CONFIRMED
    ) return result.operation;
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

  async confirmProviderOperation(operation: BillingOperation, evidence: ChargeEvidence): Promise<BillingOperation> {
    const result: OperationResult = await this.database.$transaction(async (transaction): Promise<OperationResult> => {
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
    if (result.error) throw result.error;
    return result.operation;
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

export function replayOperation(operation: BillingOperation): RecoveryCreditPurchaseCommandResponse {
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

export function operationResponse(operation: BillingOperation): RecoveryCreditPurchaseCommandResponse {
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;