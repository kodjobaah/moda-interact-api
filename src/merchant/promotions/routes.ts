import type { IncomingMessage, ServerResponse } from "node:http";
import { sanitizeLogFields, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import {
  PROMOTIONS_PATH, PROMOTION_SELECTION_PATH, PromotionDomainError, PromotionRequestError,
  isPromotionReadResponse, isPromotionSelectionResponse,
} from "./contract.js";
import { hasPromotionBody, readPromotionSelectionRequest, readPromotionsQuery } from "./request.js";
import type { MerchantPromotionsService } from "./service.js";

function respond(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

/** Map the route's wrapper/database cause to explicit Shared log fields.
 * Shared owns Error serialization and bounds; raw stacks, query/meta payloads
 * are never projected. Database text needs boundary-specific redaction first.
 */
function safeErrorDiagnostic(error: unknown) {
  if (!(error instanceof Error)) return sanitizeLogFields({ errorType: typeof error });
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const databaseError = cause ?? error;
  const code = "code" in databaseError ? databaseError.code : undefined;
  const fields = sanitizeLogFields({
    error,
    ...(cause ? { errorCause: cause } : {}),
    ...(typeof code === "string" && /^(?:P\d{4}|[0-9A-Z]{5})$/.test(code) ? { databaseCode: code } : {}),
  });
  let redactionApplied = false;
  for (const [key, original] of [["error", error], ["errorCause", cause]] as const) {
    if (!original) continue;
    const redact = (text: string) => text
      // Prisma invocation renderings can include application/query arguments.
      .replace(/\bInvalid[\s\S]*?\binvocation\b[\s\S]*/gi, "[REDACTED]")
      .replace(/\b(?:detail|context|query|parameters?|payload|customer)\s*[:=][\s\S]*/gi, "[REDACTED]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[REDACTED]")
      .replace(/\b(?:password|passwd|secret|credential|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|api[_-]?key|signature)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]")
      .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[REDACTED]")
      .replace(/\+?\d(?:[\d ().-]{5,}\d)/g, "[REDACTED]")
      .replace(/\b(?:secret|credential|password|token|authorization)\b/gi, "[REDACTED]");
    const name = redact(original.name);
    const message = redact(original.message);
    redactionApplied ||= name !== original.name || message !== original.message;
    // Redact original text before Shared truncation, including sensitive text
    // crossing its string boundary. Do not mutate the original exception.
    fields[key] = sanitizeLogFields({ ...fields[key] as Record<string, unknown>, name, message });
  }
  return sanitizeLogFields({ ...fields, redactionApplied });
}

export function createMerchantPromotionsRoutes(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantPromotionsService;
  logger: StructuredLogger;
}) {
  const { authenticator, service, logger } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const read = url.pathname === PROMOTIONS_PATH && request.method === "GET";
      const select = url.pathname === PROMOTION_SELECTION_PATH && request.method === "PUT";
      if (!read && !select) return false;
      try {
        const principal = await authenticator.authenticate(request);
        if (read) {
          if (hasPromotionBody(request)) throw new PromotionRequestError(400, "invalid_request");
          const result = await service.read(principal, readPromotionsQuery(url.searchParams));
          if (!isPromotionReadResponse(result)) throw new PromotionDomainError(409, "promotion_integrity_invalid");
          respond(response, 200, result);
        } else {
          if (url.search) throw new PromotionRequestError(400, "invalid_request");
          const result = await service.select(principal, await readPromotionSelectionRequest(request));
          if (!isPromotionSelectionResponse(result)) throw new PromotionDomainError(409, "promotion_integrity_invalid");
          respond(response, 200, result);
        }
        logger.info("merchant.promotions.access", { shopId: principal.shopId, operation: read ? "read" : "select", outcome: "success" });
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) respond(response, 401, { error: "unauthorized" });
        else if (error instanceof PromotionRequestError || error instanceof PromotionDomainError) {
          logger.warn("merchant.promotions.access.denied", { reason: error.code,
            ...safeErrorDiagnostic(error),
          });
          respond(response, error.status, { error: error.code });
        } else {
          logger.error("merchant.promotions.access.failed", { reason: "internal",
            ...safeErrorDiagnostic(error),
          });
          respond(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
