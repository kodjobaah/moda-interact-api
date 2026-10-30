import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { decodeStrictJsonBody, readBoundedBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { sendNoStoreJson } from "../../http/response.js";
import { MerchantKnowledgeReadError } from "./contract.js";
import { KnowledgeCommandError, KNOWLEDGE_ORDER_PATH, KNOWLEDGE_SOURCES_PATH,
  MAX_KNOWLEDGE_COMMAND_BYTES, parseCreateWebSource, parsePatchWebSource,
  parseSourceGeneration, parseSourceId, parseSourceOrder } from "./commands.contract.js";
import type { MerchantKnowledgeCommandService } from "./commands.service.js";

type Command = { operation: "create" | "patch" | "remove" | "refresh" | "order"; sourceId?: string };
function match(url: URL, method: string | undefined): Command | null {
  if (url.pathname === KNOWLEDGE_SOURCES_PATH && method === "POST") return { operation: "create" };
  if (url.pathname === KNOWLEDGE_ORDER_PATH && method === "PUT") return { operation: "order" };
  const detail = /^\/v1\/merchant\/merchant-knowledge\/sources\/([A-Za-z0-9_-]{1,128})(\/refresh)?$/.exec(url.pathname);
  const sourceId = detail?.[1];
  if (!sourceId) return null;
  if (detail[2] === "/refresh" && method === "POST") return { operation: "refresh", sourceId };
  if (!detail[2] && method === "PATCH") return { operation: "patch", sourceId };
  if (!detail[2] && method === "DELETE") return { operation: "remove", sourceId };
  return null;
}
async function body(request: IncomingMessage): Promise<unknown> {
  const contentType = singleHeader(request, "content-type");
  const encoding = singleHeader(request, "content-encoding");
  const length = singleHeader(request, "content-length");
  if (contentType.count !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    encoding.count > 1 || (encoding.count === 1 && encoding.value?.toLowerCase() !== "identity") ||
    length.count > 1 || (length.count === 1 && !/^\d+$/.test(length.value ?? ""))) {
    throw new KnowledgeCommandError(400, "invalid_request");
  }
  if (length.value && Number(length.value) > MAX_KNOWLEDGE_COMMAND_BYTES) {
    throw new KnowledgeCommandError(413, "request_too_large");
  }
  const bytes = await readBoundedBody(request, MAX_KNOWLEDGE_COMMAND_BYTES,
    (reason) => new KnowledgeCommandError(reason === "oversized" ? 413 : 400,
      reason === "oversized" ? "request_too_large" : "invalid_request"));
  if (!bytes.length) throw new KnowledgeCommandError(400, "invalid_request");
  try { return decodeStrictJsonBody(bytes); }
  catch { throw new KnowledgeCommandError(400, "invalid_request"); }
}
export function createMerchantKnowledgeCommandRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantKnowledgeCommandService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const command = match(url, request.method);
      if (!command) return false;
      const started = now();
      try {
        const principal = await authenticator.authenticate(request);
        if (url.search) throw new KnowledgeCommandError(400, "invalid_request");
        const parsed = await body(request);
        const id = command.sourceId ? parseSourceId(command.sourceId) : "";
        const result = command.operation === "create" ? await service.create(principal, parseCreateWebSource(parsed))
          : command.operation === "patch" ? await service.patch(principal, id, parsePatchWebSource(parsed))
          : command.operation === "refresh" ? await service.refresh(principal, id, parseSourceGeneration(parsed))
          : command.operation === "remove" ? await service.remove(principal, id, parseSourceGeneration(parsed))
          : await service.order(principal, parseSourceOrder(parsed));
        logger.info("merchant.knowledge.command", { shopId: principal.shopId, operation: command.operation,
          durationMs: Math.max(0, now() - started) });
        sendNoStoreJson(response, command.operation === "create" && result.created ? 201 : 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) sendNoStoreJson(response, 401, { error: "unauthorized" });
        else if (error instanceof KnowledgeCommandError) {
          if (error.status >= 403) logger.warn("merchant.knowledge.command.denied", { operation: command.operation, reason: error.code,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, error.status, { error: error.code });
        } else if (error instanceof MerchantKnowledgeReadError) {
          logger.warn("merchant.knowledge.command.failed", { operation: command.operation, reason: error.code,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, error.status, { error: error.code });
        } else {
          logger.error("merchant.knowledge.command.failed", { operation: command.operation, reason: "internal",
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
