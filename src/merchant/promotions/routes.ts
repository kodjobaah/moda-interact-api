import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import {
  PROMOTIONS_PATH, PROMOTION_SELECTION_PATH, PromotionDomainError, PromotionRequestError,
  isPromotionReadResponse, isPromotionSelectionResponse,
} from "./contract.js";
import { hasPromotionBody, readPromotionSelectionRequest, readPromotionsQuery } from "./request.js";
import type { MerchantPromotionsService } from "./service.js";

function respond(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

export function createMerchantPromotionsRoutes(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantPromotionsService;
  logger: StructuredLogger;
}) {
  const { authenticator, service, logger } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const read = url.pathname === PROMOTIONS_PATH && request.method === "GET";
      const select = url.pathname === PROMOTION_SELECTION_PATH && request.method === "PUT";
      if (!read && !select) return false;
      try {
        const principal = await authenticator.authenticate(request);
        if (read) {
          if (hasPromotionBody(request)) throw new PromotionRequestError(400, "invalid_request");
          const result = await service.read(principal, readPromotionsQuery(url.searchParams));
          if (!isPromotionReadResponse(result)) throw new PromotionDomainError(409, "promotion_integrity_invalid");
          respond(response, 200, result);
        } else {
          if (url.search) throw new PromotionRequestError(400, "invalid_request");
          const result = await service.select(principal, await readPromotionSelectionRequest(request));
          if (!isPromotionSelectionResponse(result)) throw new PromotionDomainError(409, "promotion_integrity_invalid");
          respond(response, 200, result);
        }
        logger.info("merchant.promotions.access", { shopId: principal.shopId, operation: read ? "read" : "select", outcome: "success" });
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) respond(response, 401, { error: "unauthorized" });
        else if (error instanceof PromotionRequestError || error instanceof PromotionDomainError) {
          logger.warn("merchant.promotions.access.denied", { reason: error.code });
          respond(response, error.status, { error: error.code });
        } else {
          logger.error("merchant.promotions.access.failed", { reason: "internal" });
          respond(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
