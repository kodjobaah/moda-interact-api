import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import { WOO_SHOP_BRAND_PATH, WooShopBrandHttpError } from "./contract.js";
import { readWooShopBrandRequest } from "./request.js";
import type { WooShopBrandService } from "./service.js";

export function createWooShopBrandRoute(options: {
  authenticator: Pick<WooInstallationAuthenticator, "authenticate">;
  service: Pick<WooShopBrandService, "record">;
  logger: StructuredLogger;
}) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== WOO_SHOP_BRAND_PATH || request.method !== "POST") return false;
      try {
        const principal = await options.authenticator.authenticate(request);
        if (url.search) throw new WooShopBrandHttpError(400, "invalid_request");
        const snapshot = await readWooShopBrandRequest(request);
        // An ACK is based only on the completed PostgreSQL transaction, never a
        // best-effort queue wake or external media-processing operation.
        const result = await options.service.record(principal, snapshot);
        options.logger.info("woocommerce.shop_brand.recorded", {
          shopId: principal.shopId, eventId: snapshot.eventId, outcome: result.status,
        });
        sendNoStoreJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          sendNoStoreJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof WooShopBrandHttpError) {
          options.logger.warn("woocommerce.shop_brand.rejected", { reason: error.code,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, error.status, { error: error.code });
        } else {
          // Log the original exception so the root cause is visible alongside the 503 classification.
          options.logger.warn("woocommerce.shop_brand.unavailable", { reason: "database_unavailable",
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, 503, { error: "shop_brand_unavailable" });
        }
      }
      return true;
    },
  };
}
