import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../woocommerce/installation/authenticator.js";
import { StoreCategoryReadError } from "./locale.js";
import type { StoreCategoriesReadService } from "./store-categories-read.service.js";

export const MERCHANT_STORE_CATEGORIES_ROUTE_PATH = "/v1/merchant/store-categories";

/** Dedicated API-005 route to keep the Woo installation router thin. */
export function createStoreCategoriesRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: StoreCategoriesReadService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== MERCHANT_STORE_CATEGORIES_ROUTE_PATH || request.method !== "GET") return false;
      const startedAt = now();
      try {
        const principal = await authenticator.authenticate(request);
        const localeValues = requestUrl.searchParams.getAll("locale");
        if (localeValues.length > 1 || requestUrl.searchParams.size !== localeValues.length || hasBody(request)) {
          throw new StoreCategoryReadError("invalid_locale");
        }
        const result = await service.read(principal, localeValues[0]);
        logger.info("merchant.store_categories.read", {
          shopId: principal.shopId,
          returnedCategoryCount: result.categories.length,
          resolvedLocale: result.resolvedLocale,
          durationMs: Math.max(0, now() - startedAt),
        });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) sendJson(response, 401, { error: "unauthorized" });
        else if (error instanceof StoreCategoryReadError) {
          if (error.code !== "invalid_locale") logger.warn("merchant.store_categories.read.failed", { reason: error.code });
          sendJson(response, error.code === "invalid_locale" ? 400 : 409, { error: error.code });
        } else {
          logger.error("merchant.store_categories.read.failed", { reason: "internal" });
          sendJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}

function hasBody(request: IncomingMessage): boolean {
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
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}
