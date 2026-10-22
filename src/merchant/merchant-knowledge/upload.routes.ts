import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { readBoundedBody, decodeStrictJsonBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { sendNoStoreJson } from "../../http/response.js";
import { KNOWLEDGE_UPLOAD_FINALIZE_PATH, KNOWLEDGE_UPLOAD_INTENTS_PATH,
  KNOWLEDGE_UPLOAD_ROUTE, UPLOAD_REQUEST_MAX_BYTES, KnowledgeUploadError,
  invalid, parseEdit, parseFinalize, parseIntent } from "./upload-contract.js";
import { MerchantKnowledgeUploadService, normaliseUploadError } from "./upload.service.js";
import { elapsedMs, timeKnowledgePhase, type KnowledgeTimings } from "./timing.js";

async function strictBody(request: IncomingMessage, empty = false): Promise<unknown> {
  if (empty) {
    // A bodyless POST may still carry Content-Type or Transfer-Encoding.
    // Validate the actual bytes instead of rejecting harmless transport headers.
    await readBoundedBody(request, 0, () => invalid());
    return undefined;
  }
  const contentType = singleHeader(request, "content-type");
  const encoding = singleHeader(request, "content-encoding");
  const length = singleHeader(request, "content-length");
  if (contentType.count !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
      encoding.count > 1 || (encoding.count === 1 && encoding.value !== "identity") || length.count > 1 ||
      (length.count === 1 && !/^\d+$/.test(length.value ?? ""))) throw invalid();
  if (length.value && Number(length.value) > UPLOAD_REQUEST_MAX_BYTES) throw new KnowledgeUploadError(413, "request_too_large");
  const body = await readBoundedBody(request, UPLOAD_REQUEST_MAX_BYTES,
    (reason) => new KnowledgeUploadError(reason === "oversized" ? 413 : 400,
      reason === "oversized" ? "request_too_large" : "invalid_request"));
  if (!body.length) throw invalid();
  try { return decodeStrictJsonBody(body); }
  catch { throw invalid(); }
}
export function createMerchantKnowledgeUploadRoutes(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantKnowledgeUploadService;
  logger: StructuredLogger;
}) {
  const { authenticator, service, logger } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "";
      const action = url.pathname === KNOWLEDGE_UPLOAD_INTENTS_PATH && method === "POST" ? "intent" :
        url.pathname === KNOWLEDGE_UPLOAD_FINALIZE_PATH && method === "POST" ? "finalize" :
        KNOWLEDGE_UPLOAD_ROUTE.exec(url.pathname);
      if (!action) return false;
      if (typeof action !== "string" && !((method === "PATCH" && !action[2]) || (method === "POST" && action[2]))) return false;
      const operation = typeof action === "string" ? action : action[2] ? "reprocess" : "edit";
      const startedAt = performance.now();
      const timings: KnowledgeTimings = {};
      try {
        const principal = await timeKnowledgePhase(timings, "authenticationMs", () => authenticator.authenticate(request));
        if (url.search) throw invalid();
        const body = await timeKnowledgePhase(timings, "requestBodyMs", () => strictBody(request, operation === "reprocess"));
        const result = action === "intent" ? await service.intent(principal, parseIntent(body), timings) :
          action === "finalize" ? await service.finalize(principal, parseFinalize(body), timings) :
          action[2] ? await service.reprocess(principal, action[1]!) :
            await service.edit(principal, action[1]!, parseEdit(body));
        // Timings are numeric only: no object keys, hashes, signed URLs, headers or customer data.
        logger.info("merchant.knowledge.upload", { shopId: principal.shopId, operation,
          ...timings, durationMs: elapsedMs(startedAt) });
        sendNoStoreJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) sendNoStoreJson(response, 401, { error: "unauthorized" });
        else {
          const failure = normaliseUploadError(error);
          if (failure.status !== 400 && failure.status !== 413) {
            // Only bounded error categories/codes are logged; Prisma messages can contain SQL and parameters.
            const possibleCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
            const prismaCode = typeof possibleCode === "string" && /^P[0-9]{4}$/.test(possibleCode)
              ? possibleCode : undefined;
            const cause = error instanceof KnowledgeUploadError ? "domain" : prismaCode ? "prisma" :
              error instanceof TypeError ? "type_error" : "unexpected";
            logger.warn("merchant.knowledge.upload.failed", { operation, reason: failure.code, cause,
              ...(prismaCode ? { prismaCode } : {}), ...timings, durationMs: elapsedMs(startedAt) });
          }
          sendNoStoreJson(response, failure.status, { error: failure.code });
        }
      }
      return true;
    },
  };
}
