import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import { MERCHANT_KNOWLEDGE_PATH, MerchantKnowledgeReadError } from "./contract.js";
import type { MerchantKnowledgeReadService } from "./read.service.js";
import { timeKnowledgePhase, type KnowledgeTimings } from "./timing.js";

function parsePosition(request: IncomingMessage, url: URL): number | null {
  if (url.searchParams.size === 0) return null;
  if (url.searchParams.size !== 1 || !url.searchParams.has("afterPosition")) {
    throw new MerchantKnowledgeReadError(400, "invalid_request");
  }
  const raw = url.searchParams.get("afterPosition");
  if (!raw || !/^(0|[1-9]\d{0,9})$/.test(raw)) throw new MerchantKnowledgeReadError(400, "invalid_request");
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number > 2147483647) throw new MerchantKnowledgeReadError(400, "invalid_request");
  return number;
}

function hasBody(request: IncomingMessage): boolean {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    const value = request.rawHeaders[index + 1];
    if (name === "transfer-encoding") return true;
    if (name === "content-length" && (value === undefined || !/^0+$/.test(value))) return true;
  }
  return false;
}

export function createMerchantKnowledgeRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantKnowledgeReadService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== MERCHANT_KNOWLEDGE_PATH || request.method !== "GET") return false;
      const started = now();
      const timings: KnowledgeTimings = {};
      try {
        const principal = await timeKnowledgePhase(timings, "authenticationMs", () => authenticator.authenticate(request));
        if (hasBody(request)) throw new MerchantKnowledgeReadError(400, "invalid_request");
        const result = await service.read(principal, parsePosition(request, url), timings);
        logger.info("merchant.knowledge.read", {
          shopId: principal.shopId, state: result.state, returnedSourceCount: result.sources.length,
          ...timings, durationMs: Math.max(0, now() - started),
        });
        sendNoStoreJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          sendNoStoreJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof MerchantKnowledgeReadError) {
          if (error.status !== 400) logger.warn("merchant.knowledge.read.failed", {
            reason: error.code, ...timings, durationMs: Math.max(0, now() - started),
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, error.status, { error: error.code });
        } else {
          logger.error("merchant.knowledge.read.failed", {
            reason: "internal", ...timings, durationMs: Math.max(0, now() - started),
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, 503, { error: "merchant_knowledge_unavailable" });
        }
      }
      return true;
    },
  };
}
