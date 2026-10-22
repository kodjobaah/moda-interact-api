import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import { UsageHistoryIntegrityError, UsageHistoryRequestError, USAGE_HISTORY_PATH,
  parseUsageHistoryQuery } from "./contract.js";
import type { MerchantUsageHistoryService } from "./history.service.js";
import { isUsageHistoryResponse } from "./schema.js";

function hasBody(request: IncomingMessage): boolean {
  const length = request.headers["content-length"];
  return request.headers["transfer-encoding"] !== undefined ||
    (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== 0));
}

export function createMerchantUsageHistoryRoute(input: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantUsageHistoryService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = input;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" || url.pathname !== USAGE_HISTORY_PATH) return false;
      const started = now();
      try {
        const principal = await authenticator.authenticate(request);
        if ((request.url?.length ?? 0) > 2048 || hasBody(request)) {
          throw new UsageHistoryRequestError("invalid_request");
        }
        const query = parseUsageHistoryQuery(url.searchParams);
        const result = await service.read(principal, query);
        if (!isUsageHistoryResponse(result)) throw new UsageHistoryIntegrityError();
        logger.info("merchant.usage_history.read", {
          shopId: principal.shopId, view: query.view, kind: query.kind,
          page: query.page, pageSize: query.pageSize, returned: result.usageEvents.length,
          state: result.state, durationMs: Math.max(0, now() - started),
        });
        sendNoStoreJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          sendNoStoreJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof UsageHistoryRequestError) {
          logger.warn("merchant.usage_history.denied", { reason: error.code });
          sendNoStoreJson(response, error.code === "invalid_request" ? 400 : 409, { error: error.code });
        } else if (error instanceof UsageHistoryIntegrityError) {
          logger.warn("merchant.usage_history.failed", { reason: "integrity" });
          sendNoStoreJson(response, 409, { error: "usage_history_integrity_invalid" });
        } else {
          logger.error("merchant.usage_history.failed", { reason: "internal" });
          sendNoStoreJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
