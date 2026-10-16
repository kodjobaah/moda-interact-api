import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import {
  WooUnauthenticatedError,
  type WooInstallationAuthenticator,
} from "../../woocommerce/installation/authenticator.js";
import { MerchantBootstrapIntegrityError, type MerchantBootstrapReadService } from "./bootstrap-read.service.js";

export const MERCHANT_BOOTSTRAP_ROUTE_PATH = "/v1/merchant/bootstrap";

/** Authenticated, tenant-scoped bootstrap read; connection and category writes are owned elsewhere. */
export function createMerchantBootstrapRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantBootstrapReadService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== MERCHANT_BOOTSTRAP_ROUTE_PATH || request.method !== "GET") return false;

      const startedAt = now();
      try {
        const principal = await authenticator.authenticate(request);
        if (url.search) {
          sendError(response, 400, "invalid_request");
          return true;
        }
        const bootstrap = await service.read(principal);
        logger.info("merchant.bootstrap.read", {
          installationId: principal.installationId,
          shopId: principal.shopId,
          outcome: "success",
          onboardingCompleted: bootstrap.shop.onboardingCompleted,
          durationMs: Math.max(0, now() - startedAt),
        });
        sendJson(response, 200, bootstrap);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          sendError(response, 401, "unauthorized");
        } else {
          logger.error("merchant.bootstrap.read.failed", {
            reason: error instanceof MerchantBootstrapIntegrityError ? "integrity" : "internal",
          });
          sendError(response, 500, "internal_error");
        }
      }
      return true;
    },
  };
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
