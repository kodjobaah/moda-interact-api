import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import { WooConsentStatusHttpError, WOO_CONSENT_STATUS_PATH } from "./contract.js";
import { readWooConsentStatusRequest } from "./request.js";
import type { WooConsentStatusService } from "./service.js";

/** Preserve the provider text except sensitive values; the Shared logger additionally
 * handles secret-key redaction and bounded structured serialisation. */
function redactDiagnostic(value: string | undefined): string | undefined {
  return value?.replace(/\+?[0-9]{9,15}/g, "[REDACTED_PHONE]");
}
function safeCause(cause: unknown): unknown {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) return {
    name: cause.name, message: redactDiagnostic(cause.message),
    stack: redactDiagnostic(cause.stack),
  };
  return redactDiagnostic(String(cause));
}


/** Use the canonical Shared logger; no unbounded request/proof/customer attributes. */
export function createWooConsentStatusRoute(options: {
  authenticator: Pick<WooInstallationAuthenticator, "authenticate">;
  service: Pick<WooConsentStatusService, "read">;
  logger: StructuredLogger;
}) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== WOO_CONSENT_STATUS_PATH || request.method !== "POST") return false;
      const start = performance.now();
      const diagnosticId = randomUUID();
      let shopScope: string | undefined;
      let stage = "authentication";
      let completedReads = 0;
      const logContext = (outcome: string, statusCode: number) => ({
        diagnosticId, operation: "read", outcome, statusCode,
        ...(shopScope ? { shopScope } : {}),
        durationMs: Math.round((performance.now() - start) * 100) / 100,
        stage, completedReads, transactionCount: 0,
      });
      try {
        const principal = await options.authenticator.authenticate(request);
        // Hash only for correlation; neither the shop nor proof ID is logged.
        shopScope = createHash("sha256").update(principal.shopId).digest("hex").slice(0, 16);
        stage = "validation";
        if (url.search) throw new WooConsentStatusHttpError(400, "invalid_request");
        const probe = await readWooConsentStatusRequest(request);
        stage = "database_read";
        const result = await options.service.read(principal, probe);
        completedReads = 1;
        options.logger.info("woocommerce.consent_status.read", logContext(result.state, 200));
        sendNoStoreJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          options.logger.warn("woocommerce.consent_status.rejected", logContext("unauthorized", 401));
          sendNoStoreJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof WooConsentStatusHttpError) {
          options.logger.warn("woocommerce.consent_status.rejected", {
            ...logContext("invalid_request", error.status), reason: error.code,
          });
          sendNoStoreJson(response, error.status, { error: error.code });
        } else {
          // Preserve the ORIGINAL Prisma/SDK error for server-side diagnostics;
          // never send DB details, phone, proof, query parameters or stacks to checkout.
          options.logger.error("woocommerce.consent_status.unavailable", {
            ...logContext("unavailable", 503),
            errorName: error instanceof Error ? error.name : typeof error,
            errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
            errorMessage: redactDiagnostic(error instanceof Error ? error.message : String(error)),
            errorStack: redactDiagnostic(error instanceof Error ? error.stack : undefined),
            errorCause: safeCause(error instanceof Error ? error.cause : undefined),
            providerHttpStatus: error && typeof error === "object" && "status" in error &&
              typeof error.status === "number" && error.status >= 100 && error.status <= 599
              ? error.status : undefined,
          });
          sendNoStoreJson(response, 503, { error: "consent_status_unavailable" });
        }
      }
      return true;
    },
  };
}
