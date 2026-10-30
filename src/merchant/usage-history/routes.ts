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
      let shopId: string | null = null;
      try {
        const principal = await authenticator.authenticate(request);
        shopId = principal.shopId;
        if ((request.url?.length ?? 0) > 2048 || hasBody(request)) {
          throw new UsageHistoryRequestError("invalid_request");
        }
        const query = parseUsageHistoryQuery(url.searchParams);
        const result = await service.read(principal, query);
        if (!isUsageHistoryResponse(result)) throw new UsageHistoryIntegrityError();
        if (result.schemaVersion === 2) {
          const unattributed = result.usageEvents.filter((event) => event.chargedAgainst === "UNATTRIBUTED");
          if (unattributed.length > 0) {
            // Missing/contradictory allocation evidence is not silently classified
            // as a paid or Free charge. Emit one bounded, safe diagnostic per page.
            logger.warn("merchant.usage_history.attribution.unattributed", {
              shopId: principal.shopId, view: query.view, page: query.page,
              count: unattributed.length, eventIds: unattributed.slice(0, 10).map((event) => event.id),
            });
          }
        }
        logger.info("merchant.usage_history.read", {
          shopId: principal.shopId, view: query.view, kind: query.kind,
          page: query.page, pageSize: query.pageSize, returned: result.usageEvents.length,
          responseVersion: result.schemaVersion, state: result.state, durationMs: Math.max(0, now() - started),
        });
        sendNoStoreJson(response, 200, result);
      } catch (error) {
        // Keep credentials, URL/query strings and customer data out of the log.
        // The shared logger safely serialises bounded Error metadata and isolates
        // logging sink failures from the HTTP response.
        const context = { ...(shopId ? { shopId } : {}), durationMs: Math.max(0, now() - started) };
        if (error instanceof WooUnauthenticatedError) {
          logger.warn("merchant.usage_history.denied", { ...context, reason: "unauthorized",
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof UsageHistoryRequestError) {
          logger.warn("merchant.usage_history.denied", { ...context, reason: error.code,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, error.code === "invalid_request" ? 400 : 409, { error: error.code });
        } else if (error instanceof UsageHistoryIntegrityError) {
          logger.error("merchant.usage_history.failed", { ...context, reason: "integrity", error,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, 409, { error: "usage_history_integrity_invalid" });
        } else {
          logger.error("merchant.usage_history.failed", { ...context, reason: "internal", error,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
