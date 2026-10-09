import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { WooBillingWebhookError } from "./webhook-errors.js";
import {
  parseWooBillingWebhookPayload,
  SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS,
  validateWooBillingWebhookTopic,
} from "./webhook-payload.js";
import { verifyWooWebhookSignature } from "./webhook-signature.js";

const secret = "known-woo-webhook-secret";
const topic = "saas_billing_contract.activated";

function signedBody(body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

test("Woo signature matches Base64 HMAC-SHA256 over exact raw bytes", () => {
  const rawBody = Buffer.from('{ "subscription" : {"id":"contract-1","status":"active"} }');
  const signature = signedBody(rawBody);
  assert.equal(signature, "DRnMKr71+KopuMQw5fgNao2RZXr1wXtyazQzJaDF4CU=");
  assert.equal(verifyWooWebhookSignature(rawBody, `\t${signature} `, secret), true);
  assert.equal(verifyWooWebhookSignature(Buffer.from(`${rawBody.toString()} `), signature, secret), false);
  assert.equal(verifyWooWebhookSignature(rawBody, signature, "different-secret"), false);
  assert.equal(verifyWooWebhookSignature(rawBody, "%%%", secret), false);
  assert.equal(verifyWooWebhookSignature(rawBody, Buffer.alloc(31).toString("base64"), secret), false);
  assert.equal(verifyWooWebhookSignature(rawBody, `${signature.slice(0, -2)}!!`, secret), false);
});

test("allows exactly the seven canonical Woo SaaS billing topics", () => {
  assert.deepEqual(SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS.map(validateWooBillingWebhookTopic), [
    ...SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS,
  ]);
  assert.throws(() => validateWooBillingWebhookTopic(undefined), (error: unknown) =>
    error instanceof WooBillingWebhookError && error.statusCode === 400 && error.code === "invalid_webhook_topic");
  assert.throws(() => validateWooBillingWebhookTopic("unknown.topic"), (error: unknown) =>
    error instanceof WooBillingWebhookError && error.statusCode === 422 && error.code === "unsupported_webhook_topic");
});

test("retains only one signed provider wrapper and extracts bounded contract identity", () => {
  const wrapper = { id: "contract-1", status: "active", arbitrary: { providerField: true } };
  const parsed = parseWooBillingWebhookPayload(
    Buffer.from(JSON.stringify({ subscription: wrapper, ignored: "tenant-looking-value" })),
    topic,
  );
  assert.equal(parsed.providerContractId, "contract-1");
  assert.deepEqual(parsed.normalizedPayload, { subscription: wrapper });
});

test("accepts either wrapper for flexible topics and requires subscriptions where documented", () => {
  for (const flexibleTopic of [
    "saas_billing_contract.activated",
    "saas_billing_contract.canceled",
    "saas_billing_contract.prepaid_term_ended",
    "saas_billing_contract.refunded",
  ] as const) {
    assert.equal(parseWooBillingWebhookPayload(Buffer.from('{"charge":{"id":"c","status":"paid"}}'), flexibleTopic).providerContractId, "c");
    assert.equal(parseWooBillingWebhookPayload(Buffer.from('{"subscription":{"id":"s","status":"active"}}'), flexibleTopic).providerContractId, "s");
  }
  for (const subscriptionTopic of [
    "saas_billing_contract.updated",
    "saas_billing_contract.renewed",
    "saas_billing_contract.paused",
  ] as const) {
    assert.throws(() => parseWooBillingWebhookPayload(Buffer.from('{"charge":{"id":"c","status":"paid"}}'), subscriptionTopic));
    assert.equal(parseWooBillingWebhookPayload(Buffer.from('{"subscription":{"id":"s","status":"active"}}'), subscriptionTopic).providerContractId, "s");
  }
});

test("rejects malformed JSON, invalid wrappers and blank or oversized contract fields", () => {
  const invalidBodies = [
    Buffer.from("{"),
    Buffer.from("[]"),
    Buffer.from("{\"other\":{}}"),
    Buffer.from('{"subscription":{},"charge":{}}'),
    Buffer.from('{"subscription":null}'),
    Buffer.from('{"subscription":{"id":" ","status":"active"}}'),
    Buffer.from('{"subscription":{"id":"id","status":""}}'),
    Buffer.from(JSON.stringify({ subscription: { id: "x".repeat(256), status: "active" } })),
    Buffer.from(JSON.stringify({ subscription: { id: "id", status: "x".repeat(65) } })),
  ];
  for (const rawBody of invalidBodies) {
    assert.throws(() => parseWooBillingWebhookPayload(rawBody, topic), (error: unknown) =>
      error instanceof WooBillingWebhookError && error.code === "invalid_webhook_payload");
  }
});

test("rejects invalid UTF-8 after signature verification boundary", () => {
  assert.throws(() => parseWooBillingWebhookPayload(Buffer.from([0xff]), topic), (error: unknown) =>
    error instanceof WooBillingWebhookError && error.code === "invalid_webhook_payload");
});