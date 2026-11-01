import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import {
  AiResponseDelayConflictError,
  AiResponseDelayIntegrityError,
  AiResponseDelayRequestError,
  AiResponseDelayUnauthorizedError,
  isAiResponseDelayRead,
  MERCHANT_AI_RESPONSE_DELAY_PATH,
} from "./contract.js";
import { readAiResponseDelayWrite, requestHasAiResponseDelayBody } from "./request.js";
import type { MerchantAiResponseDelayService } from "./service.js";

export function createMerchantAiResponseDelayRoutes(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantAiResponseDelayService;
  logger: StructuredLogger;
}) {
  const { authenticator, service, logger } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== MERCHANT_AI_RESPONSE_DELAY_PATH || !["GET", "PUT"].includes(request.method ?? "")) return false;
      const operation = request.method === "PUT" ? "update" : "read";
      try {
        const principal = await authenticator.authenticate(request);
        if (url.search || (operation === "read" && requestHasAiResponseDelayBody(request))) {
          throw new AiResponseDelayRequestError(400, "invalid_request");
        }
        const result = operation === "update"
          ? await service.update(principal, await readAiResponseDelayWrite(request))
          : await service.read(principal);
        if (!isAiResponseDelayRead(result)) throw new AiResponseDelayIntegrityError();
        logger.info("merchant.ai_response_delay.access", { shopId: principal.shopId, operation });
        sendNoStoreJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          sendNoStoreJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof AiResponseDelayUnauthorizedError) {
          sendNoStoreJson(response, 403, { error: "unauthorized" });
        } else if (error instanceof AiResponseDelayRequestError) {
          sendNoStoreJson(response, error.status, { error: error.code });
        } else if (error instanceof AiResponseDelayConflictError) {
          logFailure(logger, "warn", operation, "ai_response_delay_conflict", error);
          sendNoStoreJson(response, 409, { error: "ai_response_delay_conflict" });
        } else {
          logFailure(logger, "error", operation,
            error instanceof AiResponseDelayIntegrityError ? "integrity" : "internal", error);
          sendNoStoreJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}

function logFailure(logger: StructuredLogger, level: "warn" | "error", operation: string, reason: string, error: unknown): void {
  try {
    logger[level]("merchant.ai_response_delay.access.failed", {
      operation,
      reason,
      error,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      errorCause: error instanceof Error ? error.cause : undefined,
    });
  } catch {
    // Logger failures must not change the sanitized API response.
  }
}