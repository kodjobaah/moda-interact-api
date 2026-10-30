import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import type { ApiRouteHandler } from "../../http/route-handler.js";
import { readWooRestoreResolveRequest, WOO_RESTORE_RESOLVE_PATH, WooRestoreResolveRequestError } from "./contract.js";
import type { WooRecoveryRestoreService } from "./service.js";

export function createWooRecoveryRestoreRoute(options: {
  authenticator: Pick<WooInstallationAuthenticator, "authenticate">;
  service: Pick<WooRecoveryRestoreService, "resolve">;
  logger: StructuredLogger;
}): ApiRouteHandler {
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== WOO_RESTORE_RESOLVE_PATH || request.method !== "POST") return false;
      try {
        const principal = await options.authenticator.authenticate(request);
        if (url.search) throw new WooRestoreResolveRequestError();
        const payload = await readWooRestoreResolveRequest(request);
        const result = await options.service.resolve(principal, payload);
        if (!result) {
          options.logger.info("woocommerce.recovery_restore.resolve.denied", {
            shopId: principal.shopId, recoveryId: payload.recoveryId, outcome: "unavailable",
          });
          sendNoStoreJson(response, 404, { error: "restore_unavailable" });
          return true;
        }
        options.logger.info("woocommerce.recovery_restore.resolve.eligible", {
          shopId: principal.shopId, recoveryId: payload.recoveryId, outcome: "eligible",
        });
        sendNoStoreJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          sendNoStoreJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof WooRestoreResolveRequestError) {
          sendNoStoreJson(response, 400, { error: "invalid_request" });
        } else {
          options.logger.error("woocommerce.recovery_restore.resolve.unavailable", {
            reason: "dependency_unavailable",
          });
          sendNoStoreJson(response, 503, { error: "restore_unavailable" });
        }
      }
      return true;
    },
  };
}