export type WooBillingWebhookErrorCode =
  | "invalid_webhook_signature"
  | "webhook_payload_too_large"
  | "unsupported_webhook_content_type"
  | "unsupported_webhook_content_encoding"
  | "invalid_webhook_topic"
  | "unsupported_webhook_topic"
  | "invalid_webhook_payload"
  | "webhook_acceptance_unavailable"
  | "webhook_receipt_integrity_error";

export class WooBillingWebhookError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: WooBillingWebhookErrorCode,
  ) {
    super(code);
    this.name = "WooBillingWebhookError";
  }
}