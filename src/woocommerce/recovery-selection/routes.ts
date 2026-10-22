import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { SupportUnavailableError } from "../../merchant/support/contract.js";
import { sendNoStoreJson } from "../../http/response.js";
import { WOO_RECOVERY_SELECTION_PATH, WooRecoverySelectionError } from "./contract.js";
import { requireWooAdminAttestation, readWooRecoverySelectionChange,
  readWooRecoverySelectionQuery } from "./request.js";
import type { WooRecoverySelectionService } from "./service.js";

export function createWooRecoverySelectionRoute(options: {
  authenticator: Pick<WooInstallationAuthenticator, "authenticate">;
  service: Pick<WooRecoverySelectionService, "read" | "change">;
  logger: StructuredLogger;
}) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== WOO_RECOVERY_SELECTION_PATH ||
        (request.method !== "GET" && request.method !== "POST")) return false;
      const action = request.method === "GET" ? "read" : "change";
      try {
        // Installation bearer first; only the authenticated PHP plugin can
        // attest to a current WP admin, REST nonce and privileged capability.
        const principal = await options.authenticator.authenticate(request);
        requireWooAdminAttestation(request);
        if (action === "read") {
          sendNoStoreJson(response, 200, await options.service.read(principal,
            readWooRecoverySelectionQuery(request, url)));
        } else {
          if (url.search) throw new WooRecoverySelectionError(400, "invalid_request");
          const command = await readWooRecoverySelectionChange(request);
          const result = await options.service.change(principal, command);
          options.logger.info("woocommerce.recovery_selection.changed", {
            shopId: principal.shopId, action: command.action, outcome: result.outcome,
          });
          sendNoStoreJson(response, 200, result);
        }
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          sendNoStoreJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof SupportUnavailableError) {
          sendNoStoreJson(response, 403, { error: "merchant_unavailable" });
        } else if (error instanceof WooRecoverySelectionError) {
          options.logger.warn("woocommerce.recovery_selection.denied", { reason: error.code, operation: action });
          sendNoStoreJson(response, error.status, { error: error.code });
        } else {
          // Never log provider credentials, customer numbers, evidence references
          // or raw database exceptions.
          options.logger.warn("woocommerce.recovery_selection.unavailable", { operation: action });
          sendNoStoreJson(response, 503, { error: "selection_unavailable" });
        }
      }
      return true;
    },
  };
}
