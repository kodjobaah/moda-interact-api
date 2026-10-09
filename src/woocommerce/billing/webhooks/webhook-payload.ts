import { WooBillingWebhookError } from "./webhook-errors.js";

export const SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS = [
  "saas_billing_contract.activated",
  "saas_billing_contract.updated",
  "saas_billing_contract.renewed",
  "saas_billing_contract.paused",
  "saas_billing_contract.canceled",
  "saas_billing_contract.prepaid_term_ended",
  "saas_billing_contract.refunded",
] as const;

export type WooBillingWebhookTopic = typeof SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS[number];

export interface WooBillingWebhookPayload {
  topic: WooBillingWebhookTopic;
  providerContractId: string;
  normalizedPayload: Record<string, unknown>;
}

const SUBSCRIPTION_ONLY_TOPICS = new Set<WooBillingWebhookTopic>([
  "saas_billing_contract.updated",
  "saas_billing_contract.renewed",
  "saas_billing_contract.paused",
]);

export function validateWooBillingWebhookTopic(value: string | undefined): WooBillingWebhookTopic {
  const topic = value?.replace(/^[\t ]+|[\t ]+$/g, "");
  if (!topic) throw new WooBillingWebhookError(400, "invalid_webhook_topic");
  if (!(SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS as readonly string[]).includes(topic)) {
    throw new WooBillingWebhookError(422, "unsupported_webhook_topic");
  }
  return topic as WooBillingWebhookTopic;
}

export function parseWooBillingWebhookPayload(
  rawBody: Buffer,
  topic: WooBillingWebhookTopic,
): WooBillingWebhookPayload {
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    throw new WooBillingWebhookError(422, "invalid_webhook_payload");
  }
  if (!isRecord(root)) throw new WooBillingWebhookError(422, "invalid_webhook_payload");

  const hasSubscription = Object.hasOwn(root, "subscription");
  const hasCharge = Object.hasOwn(root, "charge");
  if (hasSubscription === hasCharge) throw new WooBillingWebhookError(422, "invalid_webhook_payload");

  const kind = hasSubscription ? "subscription" : "charge";
  if (SUBSCRIPTION_ONLY_TOPICS.has(topic) && kind !== "subscription") {
    throw new WooBillingWebhookError(422, "invalid_webhook_payload");
  }
  const contract = root[kind];
  if (!isRecord(contract) || !isBoundedText(contract.id, 255) || !isBoundedText(contract.status, 64)) {
    throw new WooBillingWebhookError(422, "invalid_webhook_payload");
  }

  return {
    topic,
    providerContractId: contract.id,
    normalizedPayload: { [kind]: contract },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, maximumCharacters: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= maximumCharacters;
}