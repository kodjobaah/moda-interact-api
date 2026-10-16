import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { BillingPresentationError, type BillingPresentationReadService } from "./billing-read.service.js";
import { BillingCatalogueError, type BillingPlanCatalogueReadService } from "./plan-catalogue-read.service.js";
import { isBillingPlanCatalogueResponse, isBillingPresentationResponse } from "./schemas.js";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";

export const BILLING_PRESENTATION_ROUTE_PATH = "/v1/billing";
export const BILLING_PLANS_ROUTE_PATH = "/v1/billing/plans";

interface BillingReadRouteOptions {
  billingReadService?: BillingPresentationReadService;
  billingPlanCatalogueReadService?: BillingPlanCatalogueReadService;
  authenticator: WooInstallationAuthenticator;
  logger: StructuredLogger;
  now?: () => number;
}

/** Handles billing GET endpoints only. Other methods and domains fall through unchanged. */
export function createBillingReadRoutes({
  billingReadService,
  billingPlanCatalogueReadService,
  authenticator,
  logger,
  now = Date.now,
}: BillingReadRouteOptions): { handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> } {
  return {
    async handle(request, response) {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname === BILLING_PRESENTATION_ROUTE_PATH && request.method === "GET" && billingReadService) {
        const startedAt = now();
        try {
          const principal = await authenticator.authenticate(request);
          if (requestUrl.search || requestHasBody(request)) throw new HttpFailure(400, "invalid_request");
          const billing = await billingReadService.read(principal, new Date(now()));
          if (!isBillingPresentationResponse(billing)) throw new BillingPresentationError("billing_integrity_invalid");
          logger.info("billing.presentation.read", {
            shopId: principal.shopId,
            experienceState: billing.experienceState,
            planKind: billing.currentPlan?.planKind ?? null,
            planId: billing.currentPlan?.merchantPricingPlanId ?? null,
            returnedTopUpCount: billing.topUps.offers.length,
            outcome: "success",
            durationMs: Math.max(0, now() - startedAt),
          });
          sendJson(response, 200, billing);
        } catch (error) {
          if (error instanceof WooUnauthenticatedError) {
            sendError(response, 401, "unauthorized");
          } else if (error instanceof HttpFailure) {
            sendError(response, error.statusCode, error.code);
          } else if (error instanceof BillingPresentationError) {
            logger.warn("billing.presentation.read.failed", { reason: error.code });
            sendError(response, 409, error.code);
          } else {
            logger.error("billing.presentation.read.failed", { reason: "internal" });
            sendError(response, 500, "internal_error");
          }
        }
        return true;
      }

      if (requestUrl.pathname === BILLING_PLANS_ROUTE_PATH && request.method === "GET" && billingPlanCatalogueReadService) {
        const startedAt = now();
        try {
          const principal = await authenticator.authenticate(request);
          const localeValues = requestUrl.searchParams.getAll("locale");
          if (
            requestHasBody(request) || requestUrl.searchParams.size !== localeValues.length || localeValues.length > 1
          ) throw new HttpFailure(400, "invalid_request");
          const catalogue = await billingPlanCatalogueReadService.read(principal, localeValues[0]);
          if (!isBillingPlanCatalogueResponse(catalogue)) throw new BillingCatalogueError("billing_catalogue_invalid");
          logger.info("billing.plans.read", {
            shopId: principal.shopId,
            resolvedLocale: catalogue.resolvedLocale,
            returnedPlanCount: catalogue.plans.length,
            outcome: "success",
            durationMs: Math.max(0, now() - startedAt),
          });
          sendJson(response, 200, catalogue);
        } catch (error) {
          if (error instanceof WooUnauthenticatedError) {
            sendError(response, 401, "unauthorized");
          } else if (error instanceof HttpFailure) {
            sendError(response, error.statusCode, error.code);
          } else if (error instanceof BillingCatalogueError) {
            if (error.code !== "billing_locale_invalid") {
              logger.warn("billing.plans.read.failed", { reason: error.code });
            }
            sendError(response, error.code === "billing_locale_invalid" ? 400 : 409, error.code);
          } else if (error instanceof BillingPresentationError) {
            logger.warn("billing.plans.read.failed", { reason: error.code });
            sendError(response, 409, error.code);
          } else {
            logger.error("billing.plans.read.failed", { reason: "internal" });
            sendError(response, 500, "internal_error");
          }
        }
        return true;
      }

      return false;
    },
  };
}

class HttpFailure extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
    this.name = "HttpFailure";
  }
}

function requestHasBody(request: IncomingMessage): boolean {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    const value = request.rawHeaders[index + 1];
    if (name === "transfer-encoding") return true;
    if (name === "content-length" && value !== undefined && (!/^\d+$/.test(value) || Number(value) > 0)) return true;
  }
  return false;
}

function sendError(response: ServerResponse, statusCode: number, code: string): void {
  sendJson(response, statusCode, { error: code });
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
