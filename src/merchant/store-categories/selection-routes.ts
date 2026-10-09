import type { IncomingMessage, ServerResponse } from "node:http";
import { Prisma } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../woocommerce/installation/authenticator.js";
import { StoreCategorySelectionError } from "./selection-errors.js";
import { isStoreCategorySelectionRequest, type StoreCategorySelectionRequest } from "./selection-schema.js";
import type { StoreCategorySelectionService } from "./store-category-selection.service.js";

export const MERCHANT_STORE_CATEGORY_SELECTION_ROUTE_PATH = "/v1/merchant/store-category";
export const MAX_CATEGORY_SELECTION_BODY_BYTES = 4096;

class CategoryRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: "invalid_request" | "request_too_large") {
    super(code);
  }
}

/** Separate from the catalogue GET; no read or Connect call can publish a category. */
export function createStoreCategorySelectionRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: StoreCategorySelectionService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== MERCHANT_STORE_CATEGORY_SELECTION_ROUTE_PATH || request.method !== "POST") return false;
      const startedAt = now();
      try {
        const principal = await authenticator.authenticate(request);
        if (url.search) throw new CategoryRequestError(400, "invalid_request");
        const payload = await parseCategorySelectionRequest(request);
        const result = await service.select(principal, payload);
        logger.info("merchant.store_category.select", {
          shopId: principal.shopId,
          categoryId: result.activeCategoryId,
          generation: result.pendingSelectionGeneration,
          mappingCount: result.activeMappingIds.length,
          outcome: "published",
          durationMs: Math.max(0, now() - startedAt),
        });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) sendJson(response, 401, { error: "unauthorized" });
        else if (error instanceof CategoryRequestError) sendJson(response, error.status, { error: error.code });
        else if (error instanceof StoreCategorySelectionError) {
          logger.warn("merchant.store_category.select.failed", { reason: error.code, durationMs: Math.max(0, now() - startedAt) });
          sendJson(response, error.code === "category_unavailable" ? 422 : 409, { error: error.code });
        } else if (error instanceof Prisma.PrismaClientKnownRequestError &&
          ["P2002", "P2034"].includes(error.code)) {
          logger.warn("merchant.store_category.select.failed", { reason: "store_category_conflict" });
          sendJson(response, 409, { error: "store_category_conflict" });
        } else {
          logger.error("merchant.store_category.select.failed", {
            reason: "internal",
            errorName: error instanceof Error ? error.name : "UnknownError",
            prismaCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null,
          });
          sendJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}

function singleHeader(request: IncomingMessage, name: string): { count: number; value?: string } {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  const value = values[0];
  return values.length === 1 && value !== undefined
    ? { count: 1, value } : { count: values.length };
}

async function parseCategorySelectionRequest(request: IncomingMessage): Promise<StoreCategorySelectionRequest> {
  const contentType = singleHeader(request, "content-type");
  const encoding = singleHeader(request, "content-encoding");
  const length = singleHeader(request, "content-length");
  if (contentType.count !== 1 ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    encoding.count > 1 || (encoding.count === 1 && encoding.value?.toLowerCase() !== "identity") ||
    length.count > 1 || (length.count === 1 && !/^\d+$/.test(length.value ?? ""))) {
    throw new CategoryRequestError(400, "invalid_request");
  }
  if (length.value && Number(length.value) > MAX_CATEGORY_SELECTION_BODY_BYTES) {
    throw new CategoryRequestError(413, "request_too_large");
  }
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onFailure);
      request.off("aborted", onFailure);
    };
    const onData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > MAX_CATEGORY_SELECTION_BODY_BYTES) {
        cleanup();
        request.resume();
        reject(new CategoryRequestError(413, "request_too_large"));
        return;
      }
      chunks.push(data);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onFailure = () => { cleanup(); reject(new CategoryRequestError(400, "invalid_request")); };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onFailure);
    request.once("aborted", onFailure);
  });
  let value: unknown;
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (body.includes("\0")) throw new Error("nul");
    value = JSON.parse(body);
  } catch {
    throw new CategoryRequestError(400, "invalid_request");
  }
  if (!isStoreCategorySelectionRequest(value)) throw new CategoryRequestError(400, "invalid_request");
  return value;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}
