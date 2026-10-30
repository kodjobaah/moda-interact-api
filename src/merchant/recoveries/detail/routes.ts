import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import {
  WooUnauthenticatedError,
  type WooInstallationAuthenticator,
} from "../../../auth/woo-installation/authenticator.js";
import { InvalidRecoveryDetailRequest, parseDetailNavigation, validRecoveryId } from "./cursor.js";
import { RecoveryDetailIntegrityError } from "./contracts.js";
import type { MerchantRecoveryDetailService } from "./read.service.js";
import { isDetailSummary, isMessagePage, isRelatedPage } from "./validate-response.js";

export const DETAIL_ROUTE_BASE = "/v1/merchant/recoveries/";
const PATH = /^\/v1\/merchant\/recoveries\/([^/]+)(?:\/(messages|related))?$/;

function requestHasBody(request: IncomingMessage): boolean {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    const value = request.rawHeaders[index + 1];
    if (name === "transfer-encoding") return true;
    if (name === "content-length" && (value === undefined || !/^0+$/.test(value))) return true;
  }
  return false;
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

/** Three independently authorised Woo merchant reads, never accessible directly from browser JS. */
export function createMerchantRecoveryDetailRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantRecoveryDetailService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const matched = PATH.exec(url.pathname);
      if (!matched || request.method !== "GET") return false;
      const startedAt = now();
      const section = matched[2] ?? "summary";
      try {
        const principal = await authenticator.authenticate(request);
        if ((request.url?.length ?? 0) > 2048 || requestHasBody(request)) {
          throw new InvalidRecoveryDetailRequest();
        }
        // URL.pathname retains percent-escaping: reject aliases rather than accepting encoded separators.
        const recoveryId = matched[1];
        if (!validRecoveryId(recoveryId)) throw new InvalidRecoveryDetailRequest();
        if (section === "summary" && url.search !== "") throw new InvalidRecoveryDetailRequest();
        if (section === "messages" || section === "related") {
          parseDetailNavigation(principal.shopId, recoveryId, section, url.searchParams);
        }
        const result = section === "messages"
          ? await service.messages(principal, recoveryId, url.searchParams)
          : section === "related"
            ? await service.related(principal, recoveryId, url.searchParams)
            : await service.summary(principal, recoveryId);
        if (result === null) {
          send(response, 404, { error: "not_found" });
          return true;
        }
        const valid = section === "messages" ? isMessagePage(result) :
          section === "related" ? isRelatedPage(result) : isDetailSummary(result);
        if (!valid) throw new RecoveryDetailIntegrityError();
        logger.info("merchant.recoveries.detail.read", {
          shopId: principal.shopId,
          section,
          durationMs: Math.max(0, now() - startedAt),
        });
        send(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) send(response, 401, { error: "unauthorized" });
        else if (error instanceof InvalidRecoveryDetailRequest) send(response, 400, { error: "invalid_request" });
        else if (error instanceof RecoveryDetailIntegrityError) {
          logger.warn("merchant.recoveries.detail.failed", { reason: "integrity", section,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          send(response, 409, { error: "recovery_detail_integrity_invalid" });
        } else {
          logger.error("merchant.recoveries.detail.failed", { reason: "internal", section,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          send(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
