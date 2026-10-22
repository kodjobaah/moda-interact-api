import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import { WooConsentHttpError, WOO_CONSENT_PATH } from "./contract.js";
import { readWooConsentRequest } from "./request.js";
import type { WooConsentService } from "./service.js";

export function createWooConsentRoute(options: {
  authenticator: Pick<WooInstallationAuthenticator, "authenticate">;
  service: Pick<WooConsentService, "record">;
  logger: StructuredLogger;
}) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== WOO_CONSENT_PATH || request.method !== "POST") return false;
      try {
        const principal = await options.authenticator.authenticate(request);
        if (url.search) throw new WooConsentHttpError(400, "invalid_request");
        const event = await readWooConsentRequest(request);
        const result = await options.service.record(principal, event);
        options.logger.info("woocommerce.consent.recorded", {
          shopId: principal.shopId, outcome: result.status, decision: result.decision,
        });
        // Only the completed PostgreSQL commit is acknowledged; never a queue receipt.
        sendNoStoreJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          sendNoStoreJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof WooConsentHttpError) {
          options.logger.warn("woocommerce.consent.rejected", { reason: error.code });
          sendNoStoreJson(response, error.status, { error: error.code });
        } else {
          // Database failure may contain customer contact/SQL arguments: don't log the exception.
          options.logger.warn("woocommerce.consent.unavailable", { reason: "database_unavailable" });
          sendNoStoreJson(response, 503, { error: "consent_unavailable" });
        }
      }
      return true;
    },
  };
}
