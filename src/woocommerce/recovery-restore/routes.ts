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
      let submittedToken: string | undefined;
      try {
        const principal = await options.authenticator.authenticate(request);
        if (url.search) throw new WooRestoreResolveRequestError();
        const payload = await readWooRestoreResolveRequest(request);
        submittedToken = payload.token;
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
            error: safeErrorDetails(error, submittedToken),
          });
          sendNoStoreJson(response, 503, { error: "restore_unavailable" });
        }
      }
      return true;
    },
  };
}

function safeErrorDetails(error: unknown, submittedToken: string | undefined) {
  if (!(error instanceof Error)) {
    return { name: typeof error, message: "[REDACTED]", redactionApplied: true, truncated: false };
  }

  const originalMessage = error.message;
  let message = originalMessage;
  if (submittedToken) message = message.replaceAll(submittedToken, "[REDACTED]");
  message = message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\+?\d(?:[\d ().-]{5,}\d)/g, "[REDACTED]")
    .replace(/\b[A-Z0-9][A-Z0-9_-]{3,}\b/g, "[REDACTED]");
  const truncated = message.length > 1024;
  return {
    name: error.name.slice(0, 128),
    message: truncated ? message.slice(0, 1024) : message,
    redactionApplied: message !== originalMessage,
    truncated,
  };
}