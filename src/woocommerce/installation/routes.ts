import type { IncomingMessage, ServerResponse } from "node:http";
import { Prisma } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { ApiRouteHandler } from "../../http/route-handler.js";
import { readBoundedBody, decodeStrictJsonBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { sendNoStoreJson as sendJson } from "../../http/response.js";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import { WooConnectionConflictError, WooInstallationConnectionService, WooSiteControlRejectedError } from "./connection-service.js";
import {
  FreePlanConfigurationUnavailableError,
  InitialFreeActivationConflictError,
} from "../billing/initial-free-activation.service.js";
import { decodeSecret } from "../../auth/woo-installation/credential.js";
import { canonicalizeWooSiteUrl, InvalidWooSiteUrlError, type WooConnectionMode } from "./site-url.js";

export const CONNECT_ROUTE_PATH = "/v1/woocommerce/installations/connect";
export const AUTH_PROBE_ROUTE_PATH = "/v1/woocommerce/installation";
export const MAX_CONNECT_BODY_BYTES = 8192;
export const MAX_SITE_URL_BYTES = 512;
export const CONNECT_REQUEST_FIELDS = ["siteUrl", "attemptId", "bootstrapSecret"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WooInstallationRouteHandler = ApiRouteHandler;

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
          } else if (error instanceof FreePlanConfigurationUnavailableError) {
            logger.error("woocommerce.installation.connect.failed", {
              reason: "free_plan_configuration_unavailable",
              errorCode: "FREE_PLAN_CONFIGURATION_UNAVAILABLE",
              configurationReason: error.reason,
              durationMs: Math.max(0, now() - startedAt),
            });
            sendError(response, 503, "FREE_PLAN_CONFIGURATION_UNAVAILABLE");
          } else if (error instanceof InitialFreeActivationConflictError) {
            sendError(response, 409, "INITIAL_FREE_ACTIVATION_CONFLICT");
          } else if (error instanceof WooConnectionConflictError) {
            sendError(response, 409, "connection_conflict");
          } else {
            logger.error("woocommerce.installation.connect.failed", {
              reason: "internal",
              errorName: error instanceof Error ? error.name : "unknown",
              ...(error instanceof Prisma.PrismaClientKnownRequestError ? { prismaCode: error.code } : {}),
              durationMs: Math.max(0, now() - startedAt),
            });
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

  const bytes = await readBoundedBody(request, MAX_CONNECT_BODY_BYTES, (reason) => reason === "oversized"
    ? new HttpFailure(413, "request_too_large")
    : new HttpFailure(400, "invalid_request"));
  let value: unknown;
  try {
    value = decodeStrictJsonBody(bytes);
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

class HttpFailure extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
    this.name = "HttpFailure";
  }
}

function sendError(response: ServerResponse, statusCode: number, code: string): void {
  sendJson(response, statusCode, { error: code });
}
