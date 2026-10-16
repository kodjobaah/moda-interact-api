import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { validateIdempotencyKey } from "./recurring-command-primitives.js";
import { RecurringBillingCommandError, type RecurringSubscriptionCommandService } from "./recurring-subscription-command.service.js";
import { RecoveryCreditPurchaseCommandError, type RecoveryCreditPurchaseCommandService } from "./recovery-credit-purchase-command.service.js";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import {
  HttpFailure,
  parseRecurringPlanRequest,
  parseRecoveryCreditPurchaseRequest,
  requestHasBody,
  sendError,
  sendJson,
  singleHeader,
} from "./command-http.js";

export const BILLING_SUBSCRIPTION_ROUTE_PATH = "/v1/billing/subscription";
export const BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH = "/v1/billing/subscription/switch";
export const BILLING_RECOVERY_CREDIT_PURCHASES_ROUTE_PATH = "/v1/billing/recovery-credit-purchases";

interface BillingCommandRouteOptions {
  recurringSubscriptionCommandService?: RecurringSubscriptionCommandService;
  recoveryCreditPurchaseCommandService?: RecoveryCreditPurchaseCommandService;
  authenticator: WooInstallationAuthenticator;
  logger: StructuredLogger;
  now?: () => number;
}

/** Handles the billing command methods; other methods (including GET history) fall through. */
export function createBillingCommandRoutes({
  recurringSubscriptionCommandService,
  recoveryCreditPurchaseCommandService,
  authenticator,
  logger,
  now = Date.now,
}: BillingCommandRouteOptions): { handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> } {
  return {
    async handle(request, response) {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (
        requestUrl.pathname === BILLING_RECOVERY_CREDIT_PURCHASES_ROUTE_PATH && request.method === "POST"
      ) {
        const startedAt = now();
        try {
          const principal = await authenticator.authenticate(request);
          const idempotencyHeader = singleHeader(request, "idempotency-key");
          const requestKey = idempotencyHeader.count === 1 ? validateIdempotencyKey(idempotencyHeader.value) : null;
          if (!requestKey) throw new HttpFailure(400, "invalid_idempotency_key");
          if (requestUrl.search) throw new HttpFailure(400, "invalid_request");
          const merchantPricingUsageEventId = await parseRecoveryCreditPurchaseRequest(request);
          if (!recoveryCreditPurchaseCommandService) {
            throw new RecoveryCreditPurchaseCommandError(503, "billing_provider_unavailable");
          }
          const result = await recoveryCreditPurchaseCommandService.initiate(
            principal,
            requestKey,
            merchantPricingUsageEventId,
          );
          logger.info("billing.recovery_credit_purchase.command", {
            shopId: principal.shopId,
            purchaseId: result.purchaseId,
            operationId: result.operationId,
            state: result.state,
            outcome: "success",
            durationMs: Math.max(0, now() - startedAt),
          });
          sendJson(response, result.state === "CONFIRMED" ? 200 : 202, result);
        } catch (error) {
          if (error instanceof WooUnauthenticatedError) {
            sendError(response, 401, "unauthorized");
          } else if (error instanceof HttpFailure) {
            sendError(response, error.statusCode, error.code);
          } else if (error instanceof RecoveryCreditPurchaseCommandError) {
            logger.warn("billing.recovery_credit_purchase.command.failed", {
              reason: error.code,
              operationId: error.operationId ?? null,
              durationMs: Math.max(0, now() - startedAt),
            });
            sendError(
              response,
              error.statusCode,
              error.code,
              error.operationId,
              error.safeProviderCode,
              error.purchaseId,
            );
          } else {
            logger.error("billing.recovery_credit_purchase.command.failed", { reason: "internal" });
            sendError(response, 500, "internal_error");
          }
        }
        return true;
      }

      if (
        (requestUrl.pathname === BILLING_SUBSCRIPTION_ROUTE_PATH && request.method === "POST") ||
        (requestUrl.pathname === BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH && request.method === "POST") ||
        (requestUrl.pathname === BILLING_SUBSCRIPTION_ROUTE_PATH && request.method === "DELETE")
      ) {
        const startedAt = now();
        try {
          const principal = await authenticator.authenticate(request);
          const idempotencyHeader = singleHeader(request, "idempotency-key");
          const requestKey = idempotencyHeader.count === 1 ? validateIdempotencyKey(idempotencyHeader.value) : null;
          if (!requestKey) throw new HttpFailure(400, "invalid_idempotency_key");
          if (requestUrl.search) throw new HttpFailure(400, "invalid_request");

          let result;
          if (request.method === "DELETE") {
            if (requestHasBody(request)) throw new HttpFailure(400, "invalid_request");
            if (!recurringSubscriptionCommandService) {
              throw new RecurringBillingCommandError(503, "billing_provider_unavailable");
            }
            result = await recurringSubscriptionCommandService.cancel(principal, requestKey);
          } else {
            const merchantPricingPlanId = await parseRecurringPlanRequest(request);
            if (!recurringSubscriptionCommandService) {
              throw new RecurringBillingCommandError(503, "billing_provider_unavailable");
            }
            result = requestUrl.pathname === BILLING_SUBSCRIPTION_ROUTE_PATH
              ? await recurringSubscriptionCommandService.create(principal, requestKey, merchantPricingPlanId)
              : await recurringSubscriptionCommandService.switchPlan(principal, requestKey, merchantPricingPlanId);
          }
          logger.info("billing.recurring.command", {
            shopId: principal.shopId,
            operationId: result.operationId,
            kind: result.kind,
            state: result.state,
            outcome: "success",
            durationMs: Math.max(0, now() - startedAt),
          });
          sendJson(response, result.state === "CONFIRMED" ? 200 : 202, result);
        } catch (error) {
          if (error instanceof WooUnauthenticatedError) {
            sendError(response, 401, "unauthorized");
          } else if (error instanceof HttpFailure) {
            sendError(response, error.statusCode, error.code);
          } else if (error instanceof RecurringBillingCommandError) {
            logger.warn("billing.recurring.command.failed", {
              reason: error.code,
              operationId: error.operationId ?? null,
              durationMs: Math.max(0, now() - startedAt),
            });
            sendError(response, error.statusCode, error.code, error.operationId, error.safeProviderCode);
          } else {
            logger.error("billing.recurring.command.failed", { reason: "internal" });
            sendError(response, 500, "internal_error");
          }
        }
        return true;
      }

      return false;
    },
  };
}
