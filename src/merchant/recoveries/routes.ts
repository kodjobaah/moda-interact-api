import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../woocommerce/installation/authenticator.js";
import { RecoveryListIntegrityError } from "./contract.js";
import { InvalidRecoveryListQuery } from "./query.js";
import { isRecoveryListResponse } from "./schema.js";
import type { MerchantRecoveryListService } from "./list.service.js";

export const MERCHANT_RECOVERIES_ROUTE_PATH = "/v1/merchant/recoveries";

function hasRequestBody(request: IncomingMessage): boolean {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    const value = request.rawHeaders[index + 1];
    if (name === "transfer-encoding") return true;
    if (name === "content-length" && (value === undefined || !/^0+$/.test(value))) return true;
  }
  return false;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

/** Hosted API: authenticated installation only; WordPress REST owns browser access. */
export function createMerchantRecoveriesRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantRecoveryListService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" || url.pathname !== MERCHANT_RECOVERIES_ROUTE_PATH) return false;
      const startedAt = now();
      try {
        const principal = await authenticator.authenticate(request);
        if ((request.url?.length ?? 0) > 2048 || hasRequestBody(request)) throw new InvalidRecoveryListQuery();
        const result = await service.read(principal, url.searchParams);
        if (!isRecoveryListResponse(result)) throw new RecoveryListIntegrityError();
        logger.info("merchant.recoveries.list.read", {
          shopId: principal.shopId,
          page: result.page,
          pageSize: result.pageSize,
          count: result.items.length,
          durationMs: Math.max(0, now() - startedAt),
        });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) sendJson(response, 401, { error: "unauthorized" });
        else if (error instanceof InvalidRecoveryListQuery) sendJson(response, 400, { error: "invalid_request" });
        else if (error instanceof RecoveryListIntegrityError) {
          logger.warn("merchant.recoveries.list.failed", { reason: "integrity" });
          sendJson(response, 409, { error: "recovery_list_integrity_invalid" });
        } else {
          logger.error("merchant.recoveries.list.failed", { reason: "internal" });
          sendJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
