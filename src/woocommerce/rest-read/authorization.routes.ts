import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { singleHeader } from "../../http/headers.js";
import type { ApiRouteHandler } from "../../http/route-handler.js";
import type { ModaSupportedLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { WooReadAuthorizationError, WooReadAuthorizationService, type WooCallbackPayload } from "./authorization.service.js";
import { renderWooReadReturnPage } from "./return-page.js";

export const WOO_READ_START_PATH = "/v1/woocommerce/read-authorizations";
export const WOO_READ_STATUS_PATH = "/v1/woocommerce/read-authorization";
export const WOO_READ_CALLBACK_PREFIX = "/v1/woocommerce/read-authorizations/callback/";
export const WOO_READ_RETURN_PATH = "/v1/woocommerce/read-authorizations/return";
const CALLBACK_BYTES_LIMIT = 4096;

class InvalidCallback extends Error {
  constructor(readonly code: string = "invalid_request", readonly status: number = 400) {
    super(code);
  }
}

export function createWooRestReadAuthorizationRoutes(options: {
  authenticator: WooInstallationAuthenticator;
  service: WooReadAuthorizationService;
  logger: StructuredLogger;
}): ApiRouteHandler {
  return {
    async handle(request, response) {
      const url = new URL(request.url ?? "/", "http://localhost");
      const { pathname } = url;
      if (pathname === WOO_READ_RETURN_PATH && request.method === "GET") {
        // Browser redirect is advisory; never use it as proof of consent or change database state.
        // user_id is WooCommerce's attempt identifier, not a trusted locale or credential.
        let locale: ModaSupportedLanguageTag = "en";
        try {
          locale = await options.service.returnLocale(
            url.searchParams.get("user_id"), url.searchParams.get("display_locale"), url.searchParams.get("display_proof"),
          );
        } catch (error) {
          // Return is informational; keep it available even if the locale lookup fails.
          options.logger.warn("woocommerce.rest_read.return_locale.unavailable", {
            reason: "lookup_failed",
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
        }
        sendReturnPage(response, locale, url.searchParams.get("success") === "0");
        return true;
      }
      if (pathname.startsWith(WOO_READ_CALLBACK_PREFIX) && request.method === "POST") {
        try {
          if (url.search) throw new InvalidCallback();
          const token = pathname.slice(WOO_READ_CALLBACK_PREFIX.length);
          if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new InvalidCallback("invalid_attempt", 404);
          const data = await parseCallbackBody(request);
          await options.service.callback(token, data);
          // WC_Auth::post_consumer_data treats only HTTP 200 as successful delivery.
          // A 204 causes WooCommerce to delete the newly issued provider key.
          response.writeHead(200, securityHeaders());
          response.end();
          options.logger.info("woocommerce.rest_read.authorization.approved", { outcome: "committed" });
        } catch (error) {
          handleFailure(error, response, options.logger, "callback");
        }
        return true;
      }
      if (
        (pathname === WOO_READ_START_PATH && request.method === "POST") ||
        (pathname === WOO_READ_STATUS_PATH && (request.method === "GET" || request.method === "DELETE"))
      ) {
        try {
          if (url.search || hasRequestBody(request)) throw new InvalidCallback();
          const principal = await options.authenticator.authenticate(request);
          if (pathname === WOO_READ_START_PATH) {
            const result = await options.service.start(principal, readAdminLocaleHeader(request));
            sendJson(response, 201, result);
            options.logger.info("woocommerce.rest_read.authorization.started", {
              installationId: principal.installationId, shopId: principal.shopId,
            });
          } else if (request.method === "DELETE") {
            const result = await options.service.revoke(principal);
            sendJson(response, 200, result);
            options.logger.info("woocommerce.rest_read.authorization.revoked", {
              installationId: principal.installationId, shopId: principal.shopId,
            });
          } else {
            sendJson(response, 200, await options.service.status(principal));
          }
        } catch (error) {
          handleFailure(error, response, options.logger, "installation");
        }
        return true;
      }
      return false;
    },
  };
}

async function parseCallbackBody(request: IncomingMessage): Promise<WooCallbackPayload> {
  const contentType = singleHeader(request, "content-type");
  const contentEncoding = singleHeader(request, "content-encoding");
  const contentLength = singleHeader(request, "content-length");
  if (
    contentType.count !== 1 ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    contentEncoding.count > 1 ||
    (contentEncoding.count === 1 && contentEncoding.value?.toLowerCase() !== "identity") ||
    contentLength.count > 1 ||
    (contentLength.count === 1 && (!/^\d+$/.test(contentLength.value ?? "") ||
      Number(contentLength.value) > CALLBACK_BYTES_LIMIT))
  ) {
    throw new InvalidCallback();
  }
  const data = await readBoundedBody(request);
  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (text.includes("\0")) throw new Error("nul");
    decoded = JSON.parse(text);
  } catch {
    throw new InvalidCallback();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new InvalidCallback();
  const parsed = decoded as Record<string, unknown>;
  const keys = ["key_id", "user_id", "consumer_key", "consumer_secret", "key_permissions"];
  if (Object.keys(parsed).length !== keys.length || !Object.keys(parsed).every((key) => keys.includes(key)) ||
    !Number.isSafeInteger(parsed.key_id) || Number(parsed.key_id) <= 0 ||
    typeof parsed.user_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.user_id) ||
    typeof parsed.consumer_key !== "string" || !/^ck_[A-Za-z0-9]{40}$/.test(parsed.consumer_key) ||
    typeof parsed.consumer_secret !== "string" || !/^cs_[A-Za-z0-9]{40}$/.test(parsed.consumer_secret)
  ) {
    throw new InvalidCallback();
  }
  if (parsed.key_permissions !== "read") throw new InvalidCallback("invalid_permissions", 422);
  return parsed as unknown as WooCallbackPayload;
}

function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAbort);
      request.off("error", onAbort);
    };
    const onData = (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += next.length;
      if (bytes > CALLBACK_BYTES_LIMIT) {
        cleanup();
        request.resume();
        reject(new InvalidCallback("request_too_large", 413));
      } else chunks.push(next);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onAbort = () => { cleanup(); reject(new InvalidCallback()); };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onAbort);
  });
}

/** WordPress sets this from get_user_locale() after its capability and nonce checks. */
function readAdminLocaleHeader(request: IncomingMessage): string | undefined {
  const header = singleHeader(request, "x-moda-admin-locale");
  if (header.count === 0) return undefined; // Older installed plugins remain compatible.
  if (header.count !== 1 || !/^[A-Za-z0-9_-]{2,64}$/.test(header.value ?? "")) {
    throw new InvalidCallback("invalid_locale");
  }
  return header.value;
}

function hasRequestBody(request: IncomingMessage): boolean {
  const length = singleHeader(request, "content-length");
  const encoding = singleHeader(request, "transfer-encoding");
  return encoding.count !== 0 || length.count > 1 ||
    (length.count === 1 && (!/^\d+$/.test(length.value ?? "") || Number(length.value) > 0));
}

function securityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  };
}

function sendJson(response: ServerResponse, code: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(code, { ...securityHeaders(), "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendReturnPage(response: ServerResponse, locale: ModaSupportedLanguageTag, cancelled: boolean): void {
  if (response.destroyed || response.headersSent) return;
  const page = renderWooReadReturnPage(locale, cancelled);
  response.writeHead(200, {
    ...securityHeaders(),
    "content-type": "text/html; charset=utf-8",
    "content-language": locale,
    "content-security-policy": page.contentSecurityPolicy,
  });
  response.end(page.html);
}

function handleFailure(error: unknown, response: ServerResponse, logger: StructuredLogger, action: string): void {
  if (error instanceof WooUnauthenticatedError) return sendJson(response, 401, { error: "unauthorized" });
  if (error instanceof InvalidCallback) return sendJson(response, error.status, { error: error.code });
  if (error instanceof WooReadAuthorizationError) {
    logger.warn("woocommerce.rest_read.authorization.failed", {
      action, reason: error.code,
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      errorCause: error.cause,
    });
    return sendJson(response, error.status, { error: error.code });
  }
  logger.error("woocommerce.rest_read.authorization.failed", {
    action, reason: "internal",
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack : undefined,
    errorCause: error instanceof Error ? error.cause : undefined,
  });
  sendJson(response, 500, { error: "internal_error" });
}
