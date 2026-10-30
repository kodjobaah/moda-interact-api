import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import { WOO_ACTIVITY_PATH, WooActivityRequestError } from "./contract.js";
import type { WooCheckoutPublisher } from "./producer.js";
import type { WooOrderPublisher } from "./order-producer.js";
import { WooCheckoutReplayConflict } from "./producer.js";
import { readWooActivityRequest } from "./request.js";

function boundedError(error: unknown): Error {
  const safe = new Error("Woo activity queue operation failed");
  safe.name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(error.name)
    ? error.name : "UnknownError";
  return safe;
}

export function createWooCheckoutActivityRoute(options: {
  authenticator: Pick<WooInstallationAuthenticator, "authenticate">;
  publisher: WooCheckoutPublisher;
  orderPublisher?: WooOrderPublisher;
  logger: StructuredLogger;
}) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== WOO_ACTIVITY_PATH || request.method !== "POST") return false;
      try {
        const principal = await options.authenticator.authenticate(request);
        if (url.search) throw new WooActivityRequestError(400, "invalid_request");
        const event = await readWooActivityRequest(request);
        let published: { duplicate: boolean; jobId: string };
        if (event.eventType === "CHECKOUT_UPDATED") {
          published = await options.publisher.publish(principal.shopId, event);
        } else {
          if (!options.orderPublisher) throw new Error("woo_order_queue_unavailable");
          published = await options.orderPublisher.publish(principal.shopId, event);
        }
        options.logger.info(event.eventType === "CHECKOUT_UPDATED"
          ? "woocommerce.activity.checkout.accepted" : "woocommerce.activity.order.accepted", {
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
          options.logger.warn("woocommerce.activity.replay.rejected", { reason: "retained_replay_conflict",
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            errorCause: error instanceof Error ? error.cause : undefined,
          });
          sendNoStoreJson(response, 409, { error: "event_replay_conflict" });
        } else {
          options.logger.warn("woocommerce.activity.queue.unavailable", {
            reason: "enqueue_failed", error: boundedError(error),
          });
          sendNoStoreJson(response, 503, { error: "queue_unavailable" });
        }
      }
      return true;
    },
  };
}
