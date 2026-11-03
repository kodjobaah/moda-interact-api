import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import {
  FeaturePreferencesConflictError, FeaturePreferencesIntegrityError, FeaturePreferencesRequestError,
  isFeaturePreferencesResponse, MERCHANT_FEATURE_PREFERENCES_PATH,
} from "./contract.js";
import { hasFeaturePreferencesBody, readFeaturePreferencesUpdate } from "./request.js";
import type { MerchantFeaturePreferencesService } from "./service.js";
import { elapsedFeatureMs, timeFeaturePhase, timeFeatureSync, type FeaturePreferencesTimings } from "./timing.js";

export function createMerchantFeaturePreferencesRoute(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantFeaturePreferencesService;
  logger: StructuredLogger;
  now?: () => number;
}) {
  const { authenticator, service, logger, now = Date.now } = options;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== MERCHANT_FEATURE_PREFERENCES_PATH || !["GET", "PUT"].includes(request.method ?? "")) return false;

      const started = now();
      const clockStarted = performance.now();
      const diagnosticId = randomUUID();
      const operation = request.method === "GET" ? "read" : "update";
      const timings: FeaturePreferencesTimings = {};
      let shopId: string | undefined;
      let statusCode = 200;
      let outcome: "success" | "rejected" | "error" = "success";
      try {
        const principal = await timeFeaturePhase(timings, "authenticationMs", () => authenticator.authenticate(request, {
          onInstallationLookupMs: (durationMs) => { timings.authenticationLookupMs = durationMs; },
        }));
        shopId = principal.shopId;
        timeFeatureSync(timings, "requestValidationMs", () => {
          if (url.search || (request.method === "GET" && hasFeaturePreferencesBody(request))) {
            throw new FeaturePreferencesRequestError(400, "invalid_request");
          }
        });
        const update = request.method === "PUT"
          ? await timeFeaturePhase(timings, "requestBodyMs", () => readFeaturePreferencesUpdate(request)) : undefined;
        const result = await timeFeaturePhase(timings, "serviceMs", async () => update
          ? service.update(principal, update, timings) : service.read(principal, timings));
        timeFeatureSync(timings, "routeResponseValidationMs", () => {
          if (!isFeaturePreferencesResponse(result)) throw new FeaturePreferencesIntegrityError();
        });
        logger.info("merchant.feature_preferences.access", {
          shopId: principal.shopId, operation, diagnosticId,
          featureCount: result.features.length, durationMs: Math.max(0, now() - started),
        });
        timeFeatureSync(timings, "responseDispatchMs", () => sendNoStoreJson(response, 200, result));
      } catch (error) {
        outcome = "rejected";
        if (error instanceof WooUnauthenticatedError) {
          statusCode = 401;
          timeFeatureSync(timings, "responseDispatchMs", () => sendNoStoreJson(response, statusCode, { error: "unauthorized" }));
        } else if (error instanceof FeaturePreferencesRequestError) {
          statusCode = error.status;
          timeFeatureSync(timings, "responseDispatchMs", () => sendNoStoreJson(response, statusCode, { error: error.code }));
        } else if (error instanceof FeaturePreferencesConflictError) {
          statusCode = 409;
          logger.warn("merchant.feature_preferences.access.failed", {
            shopId, operation, diagnosticId, reason: error.code, failedPhase: timings.failedPhase,
            errorName: error.name, errorMessage: error.message, errorStack: error.stack, errorCause: error.cause,
          });
          timeFeatureSync(timings, "responseDispatchMs", () => sendNoStoreJson(response, statusCode, { error: error.code }));
        } else if (error instanceof FeaturePreferencesIntegrityError) {
          statusCode = 409;
          logger.warn("merchant.feature_preferences.access.failed", {
            shopId, operation, diagnosticId, reason: "integrity", failedPhase: timings.failedPhase,
            errorName: error.name, errorMessage: error.message, errorStack: error.stack, errorCause: error.cause,
          });
          timeFeatureSync(timings, "responseDispatchMs", () => sendNoStoreJson(response, statusCode, { error: "feature_preferences_integrity_invalid" }));
        } else {
          outcome = "error";
          statusCode = 500;
          // Preserve the actual SDK/provider failure; never replace it with a guessed explanation.
          logger.error("merchant.feature_preferences.access.failed", {
            shopId, operation, diagnosticId, reason: "internal", failedPhase: timings.failedPhase,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorCode: error !== null && typeof error === "object" && "code" in error &&
              typeof error.code === "string" ? error.code : undefined,
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          timeFeatureSync(timings, "responseDispatchMs", () => sendNoStoreJson(response, statusCode, { error: "internal_error" }));
        }
      } finally {
        if (timings.authenticationMs !== undefined && timings.authenticationLookupMs !== undefined) {
          timings.authenticationOtherMs = Math.max(0,
            Math.round((timings.authenticationMs - timings.authenticationLookupMs) * 100) / 100);
        }
        // This always runs, including auth failures and database exceptions. No secrets or request bodies.
        // responseDispatchMs is the local response.end() invocation, NOT client receipt time.
        logger.info("merchant.feature_preferences.timing", {
          diagnosticId, ...(shopId ? { shopId } : {}), operation, outcome, statusCode,
          ...timings, durationMs: elapsedFeatureMs(clockStarted), connectionClosed: response.destroyed,
        });
      }
      return true;
    },
  };
}
