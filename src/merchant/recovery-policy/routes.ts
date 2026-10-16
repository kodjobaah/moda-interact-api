import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { sendNoStoreJson as sendJson } from "../../http/response.js";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { isRecoveryPolicyResponse, MERCHANT_RECOVERY_POLICY_ROUTE_PATH,
  RecoveryPolicyConflictError, RecoveryPolicyIntegrityError, RecoveryPolicyRequestError } from "./contract.js";
import { readRecoveryPolicyUpdate, requestHasBody } from "./request.js";
import type { MerchantRecoveryPolicyService } from "./service.js";

export function createMerchantRecoveryPolicyRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantRecoveryPolicyService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== MERCHANT_RECOVERY_POLICY_ROUTE_PATH || !["GET", "PUT"].includes(request.method ?? "")) return false;
      const started = now();
      try {
        const principal = await authenticator.authenticate(request);
        if (url.search || (request.method === "GET" && requestHasBody(request))) {
          throw new RecoveryPolicyRequestError(400, "invalid_request");
        }
        const result = request.method === "PUT"
          ? await service.update(principal, await readRecoveryPolicyUpdate(request))
          : await service.read(principal);
        if (!isRecoveryPolicyResponse(result)) throw new RecoveryPolicyIntegrityError();
        logger.info("merchant.recovery_policy.access", { shopId: principal.shopId,
          operation: request.method === "PUT" ? "update" : "read", source: result.source,
          durationMs: Math.max(0, now() - started) });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) sendJson(response, 401, { error: "unauthorized" });
        else if (error instanceof RecoveryPolicyRequestError) sendJson(response, error.status, { error: error.code });
        else if (error instanceof RecoveryPolicyConflictError) {
          logger.warn("merchant.recovery_policy.update.failed", { reason: error.code });
          sendJson(response, 409, { error: error.code });
        } else if (error instanceof RecoveryPolicyIntegrityError) {
          logger.warn("merchant.recovery_policy.access.failed", { reason: "integrity" });
          sendJson(response, 409, { error: "recovery_policy_integrity_invalid" });
        } else {
          logger.error("merchant.recovery_policy.access.failed", { reason: "internal" });
          sendJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
