import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooBillingWebhookError } from "./webhook-errors.js";
import { parseWooBillingWebhookPayload, validateWooBillingWebhookTopic } from "./webhook-payload.js";
import { WooBillingWebhookReceiptService } from "./webhook-receipt.service.js";
import { verifyWooWebhookSignature } from "./webhook-signature.js";

export const WOO_BILLING_WEBHOOK_ROUTE_PATH = "/v1/billing/webhooks/woocommerce";
export const MAX_WOO_BILLING_WEBHOOK_BODY_BYTES = 262144;

export interface WooBillingWebhookRouteHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

interface WooBillingWebhookRouteOptions {
  apiSecret?: string;
  receiptService: WooBillingWebhookReceiptService;
  logger: StructuredLogger;
}

export function createWooBillingWebhookRoute({
  apiSecret,
  receiptService,
  logger,
}: WooBillingWebhookRouteOptions): WooBillingWebhookRouteHandler {
  return {
    async handle(request, response) {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== WOO_BILLING_WEBHOOK_ROUTE_PATH || request.method !== "POST") return false;

      try {
        assertDeclaredBodyLength(request);

        const rawBody = await readBoundedRawBody(request);
        assertContentType(request);
        assertContentEncoding(request);
        const signatures = rawHeaderValues(request, "x-wc-webhook-signature");
        if (signatures.length !== 1 || !signatures[0]?.trim() || !apiSecret) {
          throw new WooBillingWebhookError(apiSecret ? 401 : 503, apiSecret ? "invalid_webhook_signature" : "webhook_acceptance_unavailable");
        }

        if (!verifyWooWebhookSignature(rawBody, signatures[0], apiSecret)) {
          throw new WooBillingWebhookError(401, "invalid_webhook_signature");
        }

        const topicHeaders = rawHeaderValues(request, "x-wc-webhook-topic");
        const topic = validateWooBillingWebhookTopic(topicHeaders.length === 1 ? topicHeaders[0] : undefined);
        const payload = parseWooBillingWebhookPayload(rawBody, topic);
        const persisted = await receiptService.persist({ ...payload, rawBody });
        logger.info("billing.woocommerce_webhook.accepted", {
          topic: payload.topic,
          providerContractId: payload.providerContractId,
          receiptId: persisted.receiptId,
          duplicate: persisted.duplicate,
        });
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      } catch (error) {
        const failure = error instanceof WooBillingWebhookError
          ? error
          : new WooBillingWebhookError(422, "invalid_webhook_payload");
        if (failure.code === "webhook_acceptance_unavailable" || failure.code === "webhook_receipt_integrity_error") {
          logger.error("billing.woocommerce_webhook.failed", { reason: failure.code });
        }
        sendError(response, failure.statusCode, failure.code);
      }
      return true;
    },
  };
}

function assertContentType(request: IncomingMessage): void {
  const values = rawHeaderValues(request, "content-type");
  const contentType = values[0]?.trim();
  if (
    values.length !== 1 ||
    !contentType ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:"[^"]+"|[^;\s]+))?\s*$/i.test(contentType)
  ) {
    throw new WooBillingWebhookError(415, "unsupported_webhook_content_type");
  }
}

function assertContentEncoding(request: IncomingMessage): void {
  const values = rawHeaderValues(request, "content-encoding");
  if (values.length > 1 || (values.length === 1 && values[0]?.trim().toLowerCase() !== "identity")) {
    throw new WooBillingWebhookError(415, "unsupported_webhook_content_encoding");
  }
}

function assertDeclaredBodyLength(request: IncomingMessage): void {
  const values = rawHeaderValues(request, "content-length");
  if (values.length > 1 || (values.length === 1 && !/^\d+$/.test(values[0] ?? ""))) {
    throw new WooBillingWebhookError(422, "invalid_webhook_payload");
  }
  if (values.length === 1 && Number(values[0]) > MAX_WOO_BILLING_WEBHOOK_BODY_BYTES) {
    throw new WooBillingWebhookError(413, "webhook_payload_too_large");
  }
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function readBoundedRawBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAbort);
      request.off("error", onError);
    };
    const rejectOnce = (error: WooBillingWebhookError) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_WOO_BILLING_WEBHOOK_BODY_BYTES) {
        rejectOnce(new WooBillingWebhookError(413, "webhook_payload_too_large"));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onAbort = () => rejectOnce(new WooBillingWebhookError(422, "invalid_webhook_payload"));
    const onError = () => rejectOnce(new WooBillingWebhookError(422, "invalid_webhook_payload"));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onError);
  });
}

function sendError(response: ServerResponse, statusCode: number, code: string): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ error: code }));
}