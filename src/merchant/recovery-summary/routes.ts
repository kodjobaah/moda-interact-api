import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../woocommerce/installation/authenticator.js";
import { RecoverySummaryIntegrityError, type MerchantRecoverySummaryService } from "./recovery-summary.service.js";

export const MERCHANT_RECOVERY_SUMMARY_ROUTE_PATH = "/v1/merchant/recovery-summary";

/** Read-only authenticated endpoint; never accepts a shop identifier from browser input. */
export function createMerchantRecoverySummaryRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantRecoverySummaryService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== MERCHANT_RECOVERY_SUMMARY_ROUTE_PATH || request.method !== "GET") return false;
      const started = now();
      try {
        const principal = await authenticator.authenticate(request);
        if (url.search || requestHasBody(request)) {
          sendJson(response, 400, { error: "invalid_request" });
          return true;
        }
        const summary = await service.read(principal, new Date());
        logger.info("merchant.recovery_summary.read", {
          shopId: principal.shopId,
          source: summary.source,
          durationMs: Math.max(0, now() - started),
        });
        sendJson(response, 200, summary);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          sendJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof RecoverySummaryIntegrityError) {
          logger.warn("merchant.recovery_summary.read.failed", { reason: "integrity" });
          sendJson(response, 409, { error: "recovery_summary_integrity_invalid" });
        } else {
          logger.error("merchant.recovery_summary.read.failed", { reason: "internal" });
          sendJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}

function requestHasBody(request: IncomingMessage): boolean {
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]?.toLowerCase();
    const value = request.rawHeaders[i + 1];
    if (name === "transfer-encoding") return true;
    if (name === "content-length" && (value === undefined || !/^0+$/.test(value))) return true;
  }
  return false;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}
