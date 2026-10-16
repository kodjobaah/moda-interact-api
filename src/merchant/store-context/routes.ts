import type { IncomingMessage, ServerResponse } from "node:http";
import { sendNoStoreJson as sendJson } from "../../http/response.js";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import {
  WooUnauthenticatedError,
  type WooInstallationAuthenticator,
} from "../../auth/woo-installation/authenticator.js";
import { MerchantStoreContextConflictError, type MerchantStoreContextService } from "./store-context.service.js";
import { MAX_STORE_CONTEXT_BODY_BYTES, parseStoreContextRequest, StoreContextHttpFailure } from "./request.js";

export const MERCHANT_STORE_CONTEXT_ROUTE_PATH = "/v1/merchant/store-context";
export { MAX_STORE_CONTEXT_BODY_BYTES };

/** Authenticated, installation-generation-guarded store settings update. */
export function createMerchantStoreContextRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantStoreContextService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== MERCHANT_STORE_CONTEXT_ROUTE_PATH || request.method !== "PUT") return false;

      const startedAt = now();
      let installationId: string | undefined;
      let shopId: string | undefined;
      try {
        const principal = await authenticator.authenticate(request);
        installationId = principal.installationId;
        shopId = principal.shopId;
        if (requestUrl.search) throw new StoreContextHttpFailure(400, "invalid_request");
        const snapshot = await parseStoreContextRequest(request);
        await service.update(principal, snapshot);
        logger.info("merchant.store_context.sync", {
          installationId, shopId, outcome: "success", durationMs: Math.max(0, now() - startedAt),
        });
        sendNoContent(response);
      } catch (error) {
        const reason = error instanceof WooUnauthenticatedError ? "unauthorized" :
          error instanceof StoreContextHttpFailure ? "invalid_request" :
            error instanceof MerchantStoreContextConflictError ? "tenant_conflict" : "internal";
        const metadata = {
          ...(installationId && shopId ? { installationId, shopId } : {}),
          reason, durationMs: Math.max(0, now() - startedAt),
        };
        if (reason === "internal") logger.error("merchant.store_context.sync.failed", metadata);
        else logger.warn("merchant.store_context.sync.failed", metadata);
        if (error instanceof WooUnauthenticatedError) sendError(response, 401, "unauthorized");
        else if (error instanceof StoreContextHttpFailure) sendError(response, error.statusCode, error.code);
        else if (error instanceof MerchantStoreContextConflictError) sendError(response, 409, "store_context_conflict");
        else sendError(response, 500, "internal_error");
      }
      return true;
    },
  };
}

function sendNoContent(response: ServerResponse): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end();
}

function sendError(response: ServerResponse, statusCode: number, code: string): void {
  sendJson(response, statusCode, { error: code });
}
