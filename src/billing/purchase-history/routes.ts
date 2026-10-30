import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { PurchaseHistoryError, type PageSize, type PurchaseFilter, type PurchaseHistoryQuery } from "./contract.js";
import { WooPurchaseHistoryReadService } from "./service.js";
import { isWooPurchaseHistoryResponse } from "./schema.js";

export const WOO_PURCHASE_HISTORY_ROUTE_PATH = "/v1/billing/recovery-credit-purchases";
const FILTERS = ["ACTIVE", "WITHDRAWN", "COMPLETED", "REFUNDED", "ALL"] as const;
const PAGE_SIZES = [5, 10, 20] as const;

class InvalidPurchaseHistoryQuery extends Error {}

function readQuery(url: URL): PurchaseHistoryQuery {
  const allowed = new Set(["filter", "page", "pageSize"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new InvalidPurchaseHistoryQuery();
  }
  const filter = url.searchParams.get("filter") ?? "ACTIVE";
  const rawPage = url.searchParams.get("page") ?? "1";
  const pageSize = Number(url.searchParams.get("pageSize") ?? "5");
  if (
    !(FILTERS as readonly string[]).includes(filter) ||
    !/^[1-9]\d{0,8}$/.test(rawPage) ||
    !(PAGE_SIZES as readonly number[]).includes(pageSize) ||
    (url.searchParams.has("pageSize") && !["5", "10", "20"].includes(url.searchParams.get("pageSize")!))
  ) throw new InvalidPurchaseHistoryQuery();
  return { filter: filter as PurchaseFilter, page: Number(rawPage), pageSize: pageSize as PageSize };
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

export function createWooPurchaseHistoryRoute(input: {
  authenticator: WooInstallationAuthenticator;
  service: WooPurchaseHistoryReadService;
  logger: StructuredLogger;
}): { handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> } {
  return {
    async handle(request, response) {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" || url.pathname !== WOO_PURCHASE_HISTORY_ROUTE_PATH) return false;
      const startedAt = Date.now();
      try {
        const principal = await input.authenticator.authenticate(request);
        const contentLength = request.headers["content-length"];
        if (request.headers["transfer-encoding"] !== undefined ||
            (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > 0))) {
          throw new InvalidPurchaseHistoryQuery();
        }
        const query = readQuery(url);
        const result = await input.service.read(principal, query);
        if (!isWooPurchaseHistoryResponse(result)) throw new PurchaseHistoryError("billing_integrity_invalid");
        input.logger.info("billing.purchase_history.read", {
          shopId: principal.shopId,
          filter: result.filter,
          page: result.page,
          returnedPurchaseCount: result.purchases.length,
          outcome: "success",
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        writeJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) writeJson(response, 401, { error: "unauthorized" });
        else if (error instanceof InvalidPurchaseHistoryQuery) writeJson(response, 400, { error: "invalid_request" });
        else if (error instanceof PurchaseHistoryError) {
          input.logger.warn("billing.purchase_history.read.failed", { reason: error.code,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          writeJson(response, 409, { error: error.code });
        } else {
          input.logger.error("billing.purchase_history.read.failed", { reason: "internal",
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          writeJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
