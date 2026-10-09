import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import {
  MAX_WOO_BILLING_WEBHOOK_BODY_BYTES,
  WOO_BILLING_WEBHOOK_ROUTE_PATH,
} from "./woo-billing-webhook-route.js";
import { SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS } from "./webhook-payload.js";

interface WebhookOpenApiDocument {
  openapi: string;
  paths: Record<string, {
    post?: {
      security?: Array<Record<string, string[]>>;
      parameters?: Array<{
        name: string;
        in: string;
        required: boolean;
        schema: { type: string; enum?: string[] };
      }>;
      requestBody?: {
        required: boolean;
        content: Record<string, { schema: { type: string; "x-max-body-bytes"?: number; "x-verify-signature-over-raw-bytes"?: boolean } }>;
      };
      responses: Record<string, unknown>;
    };
  }>;
  components: {
    responses: Record<string, {
      content?: { "application/json"?: { schema?: { $ref?: string } } };
    }>;
    schemas: Record<string, {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
    }>;
  };
}

test("Woo billing webhook OpenAPI documents the unsigned public ingress and durable receipt contract", async () => {
  const contractPath = new URL("../../../../openapi/woocommerce-billing-webhook-v1.yaml", import.meta.url);
  const document = parse(await readFile(fileURLToPath(contractPath), "utf8")) as WebhookOpenApiDocument;
  assert.equal(document.openapi, "3.1.0");

  const operation = document.paths[WOO_BILLING_WEBHOOK_ROUTE_PATH]?.post;
  assert.ok(operation);
  assert.deepEqual(operation.security, []);
  assert.deepEqual(operation.parameters?.map(({ name, in: location, required }) => [name, location, required]), [
    ["X-WC-Webhook-Signature", "header", true],
    ["X-WC-Webhook-Topic", "header", true],
  ]);
  assert.deepEqual(operation.parameters?.[1]?.schema.enum, [...SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS]);
  assert.equal(operation.requestBody?.required, true);
  const rawBodySchema = operation.requestBody?.content["application/json"]?.schema;
  assert.ok(rawBodySchema);
  assert.deepEqual([rawBodySchema.type, rawBodySchema["x-verify-signature-over-raw-bytes"], rawBodySchema["x-max-body-bytes"]], [
    "object", true, MAX_WOO_BILLING_WEBHOOK_BODY_BYTES,
  ]);
  assert.deepEqual(Object.keys(operation.responses).sort(), ["204", "400", "401", "413", "415", "422", "500", "503"]);

  const errorResponse = document.components.responses.WebhookError;
  assert.ok(errorResponse);
  const errorSchemaRef = errorResponse.content?.["application/json"]?.schema?.$ref;
  assert.equal(errorSchemaRef, "#/components/schemas/WebhookError");
  const errorSchema = document.components.schemas.WebhookError;
  assert.ok(errorSchema);
  assert.equal(errorSchema.additionalProperties, false);
  assert.deepEqual(errorSchema.required, ["error"]);
  assert.deepEqual(errorSchema.properties?.error?.enum, [
    "invalid_webhook_signature",
    "webhook_payload_too_large",
    "unsupported_webhook_content_type",
    "unsupported_webhook_content_encoding",
    "invalid_webhook_topic",
    "unsupported_webhook_topic",
    "invalid_webhook_payload",
    "webhook_acceptance_unavailable",
    "webhook_receipt_integrity_error",
  ]);
});
