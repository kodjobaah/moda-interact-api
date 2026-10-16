import type { IncomingMessage, ServerResponse } from "node:http";
import { Prisma } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { RecurringSubscriptionCommandService } from "../../billing/commands/recurring-subscription-command.service.js";
import type { RecoveryCreditPurchaseCommandService } from "../../billing/commands/recovery-credit-purchase-command.service.js";
import type { BillingPresentationReadService } from "../../billing/presentation/billing-read.service.js";
import type { BillingPlanCatalogueReadService } from "../../billing/presentation/plan-catalogue-read.service.js";
import { createBillingReadRoutes } from "../../billing/presentation/routes.js";
import { createBillingCommandRoutes } from "../../billing/commands/routes.js";
export {
  BILLING_SUBSCRIPTION_ROUTE_PATH,
  BILLING_SUBSCRIPTION_SWITCH_ROUTE_PATH,
  BILLING_RECOVERY_CREDIT_PURCHASES_ROUTE_PATH,
} from "../../billing/commands/routes.js";
export { BILLING_PRESENTATION_ROUTE_PATH, BILLING_PLANS_ROUTE_PATH } from "../../billing/presentation/routes.js";
import { MerchantBootstrapIntegrityError, MerchantBootstrapReadService } from "../../merchant/bootstrap/bootstrap-read.service.js";
import { isMerchantStoreContextSnapshot, type MerchantStoreContextSnapshot } from "../../merchant/store-context/schema.js";
import type { createMerchantRecoverySummaryRoute } from "../../merchant/recovery-summary/routes.js";
import type { createMerchantRecoveryPolicyRoute } from "../../merchant/recovery-policy/routes.js";
import type { createMerchantRecoveriesRoute } from "../../merchant/recoveries/routes.js";
import type { createMerchantRecoveryDetailRoute } from "../../merchant/recoveries/detail/routes.js";
import type { createMerchantDiscountOffersRoutes } from "../../merchant/discount-offers/routes.js";
import type { createWooPurchaseHistoryRoute } from "../../billing/purchase-history/routes.js";
import type { createStoreCategoriesRoute } from "../../merchant/store-categories/routes.js";
import type { createStoreCategorySelectionRoute } from "../../merchant/store-categories/selection-routes.js";
import { MerchantStoreContextConflictError, MerchantStoreContextService } from "../../merchant/store-context/store-context.service.js";
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
export const MERCHANT_STORE_CONTEXT_ROUTE_PATH = "/v1/merchant/store-context";
export const MAX_CONNECT_BODY_BYTES = 8192;
export const MAX_STORE_CONTEXT_BODY_BYTES = 2048;
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
  storeContextService: MerchantStoreContextService;
  recoverySummaryRoute?: ReturnType<typeof createMerchantRecoverySummaryRoute>;
  recoveryPolicyRoute?: ReturnType<typeof createMerchantRecoveryPolicyRoute>;
  recoveriesRoute?: ReturnType<typeof createMerchantRecoveriesRoute>;
  recoveryDetailRoute?: ReturnType<typeof createMerchantRecoveryDetailRoute>;
  discountOffersRoutes?: ReturnType<typeof createMerchantDiscountOffersRoutes>;
  storeCategoriesRoute?: ReturnType<typeof createStoreCategoriesRoute>;
  storeCategorySelectionRoute?: ReturnType<typeof createStoreCategorySelectionRoute>;
  billingReadService?: BillingPresentationReadService;
  purchaseHistoryRoute?: ReturnType<typeof createWooPurchaseHistoryRoute>;
  billingPlanCatalogueReadService?: BillingPlanCatalogueReadService;
  recurringSubscriptionCommandService?: RecurringSubscriptionCommandService;
  recoveryCreditPurchaseCommandService?: RecoveryCreditPurchaseCommandService;
  authenticator: WooInstallationAuthenticator;
  logger: StructuredLogger;
  now?: () => number;
}

export function createWooInstallationRoutes({
  mode,
  connectionService,
  bootstrapReadService,
  storeContextService,
  storeCategoriesRoute,
  storeCategorySelectionRoute,
  recoverySummaryRoute,
  recoveryPolicyRoute,
  recoveriesRoute,
  recoveryDetailRoute,
  discountOffersRoutes,
  billingReadService,
  purchaseHistoryRoute,
  billingPlanCatalogueReadService,
  recurringSubscriptionCommandService,
  recoveryCreditPurchaseCommandService,
  authenticator,
  logger,
  now = Date.now,
}: WooInstallationRouteOptions): WooInstallationRouteHandler {
  const billingReadRoutes = createBillingReadRoutes({
    ...(billingReadService ? { billingReadService } : {}),
    ...(billingPlanCatalogueReadService ? { billingPlanCatalogueReadService } : {}),
    authenticator,
    logger,
    now,
  });
  const billingCommandRoutes = createBillingCommandRoutes({
    ...(recurringSubscriptionCommandService ? { recurringSubscriptionCommandService } : {}),
    ...(recoveryCreditPurchaseCommandService ? { recoveryCreditPurchaseCommandService } : {}),
    authenticator,
    logger,
    now,
  });
  return {
    async handle(request, response) {
      if (recoverySummaryRoute && await recoverySummaryRoute.handle(request, response)) return true;
      if (recoveryPolicyRoute && await recoveryPolicyRoute.handle(request, response)) return true;
      if (recoveriesRoute && await recoveriesRoute.handle(request, response)) return true;
      if (recoveryDetailRoute && await recoveryDetailRoute.handle(request, response)) return true;
      if (discountOffersRoutes && await discountOffersRoutes.handle(request, response)) return true;
      if (purchaseHistoryRoute && await purchaseHistoryRoute.handle(request, response)) return true;
      if (storeCategoriesRoute && await storeCategoriesRoute.handle(request, response)) return true;
      if (storeCategorySelectionRoute && await storeCategorySelectionRoute.handle(request, response)) return true;
      if (await billingReadRoutes.handle(request, response)) return true;
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

      if (requestUrl.pathname === MERCHANT_STORE_CONTEXT_ROUTE_PATH && request.method === "PUT") {
        const startedAt = now();
        let installationId: string | undefined;
        let shopId: string | undefined;
        try {
          const principal = await authenticator.authenticate(request);
          installationId = principal.installationId;
          shopId = principal.shopId;
          if (requestUrl.search) throw new HttpFailure(400, "invalid_request");
          const snapshot = await parseStoreContextRequest(request);
          await storeContextService.update(principal, snapshot);
          logger.info("merchant.store_context.sync", {
            installationId, shopId, outcome: "success", durationMs: Math.max(0, now() - startedAt),
          });
          sendNoContent(response);
        } catch (error) {
          const reason = error instanceof WooUnauthenticatedError ? "unauthorized" :
            error instanceof HttpFailure ? "invalid_request" :
              error instanceof MerchantStoreContextConflictError ? "tenant_conflict" : "internal";
          const metadata = {
            ...(installationId && shopId ? { installationId, shopId } : {}),
            reason, durationMs: Math.max(0, now() - startedAt),
          };
          if (reason === "internal") logger.error("merchant.store_context.sync.failed", metadata);
          else logger.warn("merchant.store_context.sync.failed", metadata);
          if (error instanceof WooUnauthenticatedError) sendError(response, 401, "unauthorized");
          else if (error instanceof HttpFailure) sendError(response, error.statusCode, error.code);
          else if (error instanceof MerchantStoreContextConflictError) sendError(response, 409, "store_context_conflict");
          else sendError(response, 500, "internal_error");
        }
        return true;
      }

      if (await billingCommandRoutes.handle(request, response)) return true;

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

async function parseStoreContextRequest(request: IncomingMessage): Promise<MerchantStoreContextSnapshot> {
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
  ) throw new HttpFailure(400, "invalid_request");
  if (contentLength.value && Number(contentLength.value) > MAX_STORE_CONTEXT_BODY_BYTES) {
    throw new HttpFailure(413, "request_too_large");
  }
  const bytes = await readBoundedBody(request, MAX_STORE_CONTEXT_BODY_BYTES);
  let body: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("nul");
    body = JSON.parse(text);
  } catch {
    throw new HttpFailure(400, "invalid_request");
  }
  if (!isMerchantStoreContextSnapshot(body)) throw new HttpFailure(400, "invalid_request");
  return body;
}

function readBoundedBody(request: IncomingMessage, maximumBytes = MAX_CONNECT_BODY_BYTES): Promise<Buffer> {
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
      if (size > maximumBytes) {
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

function sendNoContent(response: ServerResponse): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end();
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