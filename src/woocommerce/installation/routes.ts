import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { BillingPresentationError, BillingPresentationReadService } from "../../billing/presentation/billing-read.service.js";
import { BillingCatalogueError, BillingPlanCatalogueReadService } from "../../billing/presentation/plan-catalogue-read.service.js";
import { isBillingPlanCatalogueResponse, isBillingPresentationResponse } from "../../billing/presentation/schemas.js";
import { MerchantBootstrapIntegrityError, MerchantBootstrapReadService } from "../../merchant/bootstrap/bootstrap-read.service.js";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "./authenticator.js";
import { WooConnectionConflictError, WooInstallationConnectionService, WooSiteControlRejectedError } from "./connection-service.js";
import {
  FreePlanConfigurationUnavailableError,
  InitialFreeActivationConflictError,
} from "../billing/initial-free-activation.service.js";
import { decodeSecret } from "./credential.js";
import { canonicalizeWooSiteUrl, InvalidWooSiteUrlError, type WooConnectionMode } from "./site-url.js";

export const CONNECT_ROUTE_PATH = "/v1/woocommerce/installations/connect";
export const AUTH_PROBE_ROUTE_PATH = "/v1/woocommerce/installation";
export const MERCHANT_BOOTSTRAP_ROUTE_PATH = "/v1/merchant/bootstrap";
export const BILLING_PRESENTATION_ROUTE_PATH = "/v1/billing";
export const BILLING_PLANS_ROUTE_PATH = "/v1/billing/plans";
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
  bootstrapReadService: MerchantBootstrapReadService;
  billingReadService?: BillingPresentationReadService;
  billingPlanCatalogueReadService?: BillingPlanCatalogueReadService;
  authenticator: WooInstallationAuthenticator;
  logger: StructuredLogger;
  now?: () => number;
}

export function createWooInstallationRoutes({
  mode,
  connectionService,
  bootstrapReadService,
  billingReadService,
  billingPlanCatalogueReadService,
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

      if (requestUrl.pathname === MERCHANT_BOOTSTRAP_ROUTE_PATH && request.method === "GET") {
        const startedAt = now();
        try {
          const principal = await authenticator.authenticate(request);
          if (requestUrl.search) throw new HttpFailure(400, "invalid_request");
          const bootstrap = await bootstrapReadService.read(principal);
          logger.info("merchant.bootstrap.read", {
            installationId: principal.installationId,
            shopId: principal.shopId,
            outcome: "success",
            onboardingCompleted: bootstrap.shop.onboardingCompleted,
            durationMs: Math.max(0, now() - startedAt),
          });
          sendJson(response, 200, bootstrap);
        } catch (error) {
          if (error instanceof WooUnauthenticatedError) {
            sendError(response, 401, "unauthorized");
          } else if (error instanceof HttpFailure) {
            sendError(response, error.statusCode, error.code);
          } else {
            logger.error("merchant.bootstrap.read.failed", {
              reason: error instanceof MerchantBootstrapIntegrityError ? "integrity" : "internal",
            });
            sendError(response, 500, "internal_error");
          }
        }
        return true;
      }

      if (requestUrl.pathname === BILLING_PRESENTATION_ROUTE_PATH && request.method === "GET" && billingReadService) {
        const startedAt = now();
        try {
          const principal = await authenticator.authenticate(request);
          if (requestUrl.search || requestHasBody(request)) throw new HttpFailure(400, "invalid_request");
          const billing = await billingReadService.read(principal, new Date(now()));
          if (!isBillingPresentationResponse(billing)) throw new BillingPresentationError("billing_integrity_invalid");
          logger.info("billing.presentation.read", {
            shopId: principal.shopId,
            experienceState: billing.experienceState,
            planKind: billing.currentPlan?.planKind ?? null,
            planId: billing.currentPlan?.merchantPricingPlanId ?? null,
            returnedTopUpCount: billing.topUps.offers.length,
            outcome: "success",
            durationMs: Math.max(0, now() - startedAt),
          });
          sendJson(response, 200, billing);
        } catch (error) {
          if (error instanceof WooUnauthenticatedError) {
            sendError(response, 401, "unauthorized");
          } else if (error instanceof HttpFailure) {
            sendError(response, error.statusCode, error.code);
          } else if (error instanceof BillingPresentationError) {
            logger.warn("billing.presentation.read.failed", { reason: error.code });
            sendError(response, 409, error.code);
          } else {
            logger.error("billing.presentation.read.failed", { reason: "internal" });
            sendError(response, 500, "internal_error");
          }
        }
        return true;
      }

      if (requestUrl.pathname === BILLING_PLANS_ROUTE_PATH && request.method === "GET" && billingPlanCatalogueReadService) {
        const startedAt = now();
        try {
          const principal = await authenticator.authenticate(request);
          const localeValues = requestUrl.searchParams.getAll("locale");
          if (
            requestHasBody(request) || requestUrl.searchParams.size !== localeValues.length || localeValues.length > 1
          ) throw new HttpFailure(400, "invalid_request");
          const catalogue = await billingPlanCatalogueReadService.read(principal, localeValues[0]);
          if (!isBillingPlanCatalogueResponse(catalogue)) throw new BillingCatalogueError("billing_catalogue_invalid");
          logger.info("billing.plans.read", {
            shopId: principal.shopId,
            resolvedLocale: catalogue.resolvedLocale,
            returnedPlanCount: catalogue.plans.length,
            outcome: "success",
            durationMs: Math.max(0, now() - startedAt),
          });
          sendJson(response, 200, catalogue);
        } catch (error) {
          if (error instanceof WooUnauthenticatedError) {
            sendError(response, 401, "unauthorized");
          } else if (error instanceof HttpFailure) {
            sendError(response, error.statusCode, error.code);
          } else if (error instanceof BillingCatalogueError) {
            if (error.code !== "billing_locale_invalid") {
              logger.warn("billing.plans.read.failed", { reason: error.code });
            }
            sendError(response, error.code === "billing_locale_invalid" ? 400 : 409, error.code);
          } else if (error instanceof BillingPresentationError) {
            logger.warn("billing.plans.read.failed", { reason: error.code });
            sendError(response, 409, error.code);
          } else {
            logger.error("billing.plans.read.failed", { reason: "internal" });
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

function requestHasBody(request: IncomingMessage): boolean {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    const value = request.rawHeaders[index + 1];
    if (name === "transfer-encoding") return true;
    if (name === "content-length" && value !== undefined && (!/^\d+$/.test(value) || Number(value) > 0)) return true;
  }
  return false;
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