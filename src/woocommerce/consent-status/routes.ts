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

/** API-006-specific redaction of proof and installation identifiers before the
 * canonical Shared logger handles generic bounded structured serialisation.
 * Preserve the provider's actual error message outside the sensitive spans.
 */
function redactDiagnostic(value: string | undefined, privateValues: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  // Redact generic credentials and contact details *before* exact scoped
  // identifiers, so a known phone is classified as PHONE rather than IDENTITY.
  // Accept the entire Bearer token (including hyphens), not just its prefix.
  let safe = value
    .replace(/\b(authorization|x-moda-installation-credential|password|access[_-]?token|api[_-]?key|secret)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,
      "$1=[REDACTED_TOKEN]")
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED_TOKEN]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\+?\d[\d ().-]{8,}\d/g, "[REDACTED_PHONE]");
  for (const secret of privateValues) {
    if (secret.length > 0) safe = safe.split(secret).join("[REDACTED_IDENTITY]");
  }
  return safe;
}

function safeCause(cause: unknown, privateValues: readonly string[]): unknown {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) return {
    name: cause.name,
    message: redactDiagnostic(cause.message, privateValues),
    stack: redactDiagnostic(cause.stack, privateValues),
    ...( "code" in cause && (typeof cause.code === "string" || typeof cause.code === "number")
      ? { code: cause.code } : {}),
  };
  if (cause && typeof cause === "object") {
    // Do not stringify arbitrary provider response objects containing secrets.
    const record = cause as Record<string, unknown>;
    return {
      ...(typeof record.name === "string" ? { name: redactDiagnostic(record.name, privateValues) } : {}),
      ...(typeof record.message === "string" ? { message: redactDiagnostic(record.message, privateValues) } : {}),
      ...(typeof record.code === "string" || typeof record.code === "number" ? { code: record.code } : {}),
    };
  }
  return redactDiagnostic(String(cause), privateValues);
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
      const privateValues: string[] = [];
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
        privateValues.push(principal.shopId, principal.installationId, principal.canonicalSiteUrl);
        // Hash only for correlation; neither the shop nor proof ID is logged.
        shopScope = createHash("sha256").update(principal.shopId).digest("hex").slice(0, 16);
        stage = "validation";
        if (url.search) throw new WooConsentStatusHttpError(400, "invalid_request");
        const probe = await readWooConsentStatusRequest(request);
        privateValues.push(probe.canonicalPhone, probe.grantEventId);
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
            errorMessage: redactDiagnostic(error instanceof Error ? error.message : String(error), privateValues),
            errorStack: redactDiagnostic(error instanceof Error ? error.stack : undefined, privateValues),
            errorCause: safeCause(error instanceof Error ? error.cause : undefined, privateValues),
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
