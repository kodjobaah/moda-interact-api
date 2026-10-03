import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "./authenticator.js";
import { WooConnectionConflictError, WooInstallationConnectionService, WooSiteControlRejectedError } from "./connection-service.js";
import { decodeSecret } from "./credential.js";
import { canonicalizeWooSiteUrl, InvalidWooSiteUrlError, type WooConnectionMode } from "./site-url.js";

export const CONNECT_ROUTE_PATH = "/v1/woocommerce/installations/connect";
export const AUTH_PROBE_ROUTE_PATH = "/v1/woocommerce/installation";
export const MAX_CONNECT_BODY_BYTES = 8192;
export const MAX_SITE_URL_BYTES = 512;
export const CONNECT_REQUEST_FIELDS = ["siteUrl", "attemptId", "bootstrapSecret"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WooInstallationRouteHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

interface WooInstallationRouteOptions {
  mode: WooConnectionMode;
  connectionService: WooInstallationConnectionService;
  authenticator: WooInstallationAuthenticator;
  logger: StructuredLogger;
  now?: () => number;
}

export function createWooInstallationRoutes({
  mode,
  connectionService,
  authenticator,
  logger,
  now = Date.now,
}: WooInstallationRouteOptions): WooInstallationRouteHandler {
  return {
    async handle(request, response) {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname === CONNECT_ROUTE_PATH && request.method === "POST") {
        const startedAt = now();
        try {
          if (requestUrl.search) throw new HttpFailure(400, "invalid_request");
          const payload = await parseConnectRequest(request);
          const site = canonicalizeWooSiteUrl(payload.siteUrl, mode);
          const result = await connectionService.connect({
            site,
            attemptId: payload.attemptId,
            bootstrapSecret: payload.bootstrapSecret,
          });
          logger.info("woocommerce.installation.connect", {
            installationId: result.installationId,
            shopId: result.shopId,
            outcome: result.connection,
            durationMs: Math.max(0, now() - startedAt),
          });
          sendJson(response, result.connection === "CREATED" ? 201 : 200, result);
        } catch (error) {
          if (error instanceof HttpFailure) {
            sendError(response, error.statusCode, error.code);
          } else if (error instanceof InvalidWooSiteUrlError) {
            sendError(response, 400, "invalid_request");
          } else if (error instanceof WooSiteControlRejectedError) {
            sendError(response, 422, "site_verification_failed");
          } else if (error instanceof WooConnectionConflictError) {
            sendError(response, 409, "connection_conflict");
          } else {
            logger.error("woocommerce.installation.connect.failed", { reason: "internal" });
            sendError(response, 500, "internal_error");
          }
        }
        return true;
      }

      if (requestUrl.pathname === AUTH_PROBE_ROUTE_PATH && request.method === "GET") {
        try {
          const principal = await authenticator.authenticate(request);
          sendJson(response, 200, principal);
        } catch (error) {
          if (error instanceof WooUnauthenticatedError) {
            sendError(response, 401, "unauthorized");
          } else {
            logger.error("woocommerce.installation.authentication.failed", { reason: "internal" });
            sendError(response, 500, "internal_error");
          }
        }
        return true;
      }

      return false;
    },
  };
}

async function parseConnectRequest(
  request: IncomingMessage,
): Promise<{ siteUrl: string; attemptId: string; bootstrapSecret: Buffer }> {
  const contentType = singleHeader(request, "content-type");
  const contentEncoding = singleHeader(request, "content-encoding");
  const contentLength = singleHeader(request, "content-length");
  if (
    contentType.count !== 1 ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    contentEncoding.count > 1 ||
    (contentEncoding.count === 1 && contentEncoding.value?.toLowerCase() !== "identity") ||
    contentLength.count > 1 ||
    (contentLength.count === 1 && !/^\d+$/.test(contentLength.value ?? ""))
  ) {
    throw new HttpFailure(400, "invalid_request");
  }
  if (contentLength.value && Number(contentLength.value) > MAX_CONNECT_BODY_BYTES) {
    throw new HttpFailure(413, "request_too_large");
  }

  const bytes = await readBoundedBody(request);
  let value: unknown;
  try {
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bodyText.includes("\0")) throw new Error("nul");
    value = JSON.parse(bodyText);
  } catch {
    throw new HttpFailure(400, "invalid_request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpFailure(400, "invalid_request");
  }

  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== CONNECT_REQUEST_FIELDS.length ||
    !Object.keys(body).every((key) => (CONNECT_REQUEST_FIELDS as readonly string[]).includes(key)) ||
    typeof body.siteUrl !== "string" ||
    Buffer.byteLength(body.siteUrl, "utf8") > MAX_SITE_URL_BYTES ||
    typeof body.attemptId !== "string" ||
    !UUID_PATTERN.test(body.attemptId) ||
    typeof body.bootstrapSecret !== "string"
  ) {
    throw new HttpFailure(400, "invalid_request");
  }
  const bootstrapSecret = decodeSecret(body.bootstrapSecret);
  if (!bootstrapSecret) throw new HttpFailure(400, "invalid_request");
  return { siteUrl: body.siteUrl, attemptId: body.attemptId, bootstrapSecret };
}

function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAbort);
      request.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_CONNECT_BODY_BYTES) {
        cleanup();
        request.resume();
        reject(new HttpFailure(413, "request_too_large"));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onAbort = () => {
      cleanup();
      reject(new HttpFailure(400, "invalid_request"));
    };
    const onError = () => {
      cleanup();
      reject(new HttpFailure(400, "invalid_request"));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onError);
  });
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
    ? { count: 1, value }
    : { count: values.length };
}

class HttpFailure extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
    this.name = "HttpFailure";
  }
}

function sendError(response: ServerResponse, statusCode: number, code: string): void {
  sendJson(response, statusCode, { error: code });
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}