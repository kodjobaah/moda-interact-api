import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import {
  FeaturePreferencesConflictError, FeaturePreferencesIntegrityError, FeaturePreferencesRequestError,
  isFeaturePreferencesResponse, MERCHANT_FEATURE_PREFERENCES_PATH,
} from "./contract.js";
import { hasFeaturePreferencesBody, readFeaturePreferencesUpdate } from "./request.js";
import type { MerchantFeaturePreferencesService } from "./service.js";

export function createMerchantFeaturePreferencesRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantFeaturePreferencesService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== MERCHANT_FEATURE_PREFERENCES_PATH || !["GET", "PUT"].includes(request.method ?? "")) return false;
      const started = now();
      try {
        const principal = await authenticator.authenticate(request);
        if (url.search || (request.method === "GET" && hasFeaturePreferencesBody(request))) {
          throw new FeaturePreferencesRequestError(400, "invalid_request");
        }
        const result = request.method === "GET" ? await service.read(principal)
          : await service.update(principal, await readFeaturePreferencesUpdate(request));
        if (!isFeaturePreferencesResponse(result)) throw new FeaturePreferencesIntegrityError();
        logger.info("merchant.feature_preferences.access", {
          shopId: principal.shopId, operation: request.method === "GET" ? "read" : "update",
          featureCount: result.features.length, durationMs: Math.max(0, now() - started),
        });
        sendNoStoreJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) sendNoStoreJson(response, 401, { error: "unauthorized" });
        else if (error instanceof FeaturePreferencesRequestError) sendNoStoreJson(response, error.status, { error: error.code });
        else if (error instanceof FeaturePreferencesConflictError) {
          logger.warn("merchant.feature_preferences.access.failed", { reason: error.code });
          sendNoStoreJson(response, 409, { error: error.code });
        } else if (error instanceof FeaturePreferencesIntegrityError) {
          logger.warn("merchant.feature_preferences.access.failed", { reason: "integrity" });
          sendNoStoreJson(response, 409, { error: "feature_preferences_integrity_invalid" });
        } else {
          logger.error("merchant.feature_preferences.access.failed", { reason: "internal" });
          sendNoStoreJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
