import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import { WOO_ACTIVITY_PATH, WooActivityRequestError } from "./contract.js";
import type { WooCheckoutPublisher } from "./producer.js";
import { WooCheckoutReplayConflict } from "./producer.js";
import { readWooCheckoutRequest } from "./request.js";

export function createWooCheckoutActivityRoute(options: {
  authenticator: Pick<WooInstallationAuthenticator, "authenticate">;
  publisher: WooCheckoutPublisher;
  logger: StructuredLogger;
}) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== WOO_ACTIVITY_PATH || request.method !== "POST") return false;
      try {
        const principal = await options.authenticator.authenticate(request);
        if (url.search) throw new WooActivityRequestError(400, "invalid_request");
        const event = await readWooCheckoutRequest(request);
        const published = await options.publisher.publish(principal.shopId, event);
        options.logger.info("woocommerce.activity.checkout.accepted", {
          shopId: principal.shopId, eventType: event.eventType,
          outcome: published.duplicate ? "retained" : "enqueued",
        });
        sendNoStoreJson(response, 202, { status: "accepted" });
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) {
          sendNoStoreJson(response, 401, { error: "unauthorized" });
        } else if (error instanceof WooActivityRequestError) {
          sendNoStoreJson(response, error.status, { error: error.code });
        } else if (error instanceof WooCheckoutReplayConflict) {
          options.logger.warn("woocommerce.activity.checkout.rejected", { reason: "retained_replay_conflict" });
          sendNoStoreJson(response, 409, { error: "event_replay_conflict" });
        } else {
          // Redis/queue errors are retryable; never log the exception (may contain a URL/secret).
          options.logger.warn("woocommerce.activity.checkout.unavailable", { reason: "enqueue_failed" });
          sendNoStoreJson(response, 503, { error: "queue_unavailable" });
        }
      }
      return true;
    },
  };
}
