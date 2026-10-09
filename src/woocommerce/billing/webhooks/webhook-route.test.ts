import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { connect } from "node:net";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { loadRuntimeConfig } from "../../../runtime-config.js";
import { createApiRuntime } from "../../../server.js";
import { createWooBillingWebhookRoute, MAX_WOO_BILLING_WEBHOOK_BODY_BYTES } from "./woo-billing-webhook-route.js";
import { WooBillingWebhookReceiptService } from "./webhook-receipt.service.js";

const secret = "woo-webhook-test-secret";
const topic = "saas_billing_contract.activated";
const basePayload = '{"subscription":{"id":"contract-1","status":"active","providerField":"kept"},"shopId":"must-not-persist"}';

interface HttpResult {
  status: number;
  cacheControl: string | undefined;
  body: string;
}

interface StoredReceipt {
  id: string;
  topic: string;
  providerContractId: string;
  payloadSha256: Buffer;
  normalizedPayload: unknown;
  billingOperationId: null;
  processedAt: null;
  processingError: null;
}

async function withWebhookApi(
  callback: (baseUrl: string, receipts: StoredReceipt[], logLines: string[]) => Promise<void>,
  options: { apiSecret?: string; failInsert?: boolean } = {},
): Promise<void> {
  const receipts: StoredReceipt[] = [];
  const logLines: string[] = [];
  const receiptByDigest = new Map<string, StoredReceipt>();
  let nextId = 0;
  const delegate = {
    create: async (args: { data: Record<string, unknown> }) => {
      if (options.failInsert) throw new Error("database connection password=private");
      const data = args.data;
      const digest = Buffer.from(data.payloadSha256 as Uint8Array);
      const key = `${String(data.topic)}:${digest.toString("hex")}`;
      if (receiptByDigest.has(key)) {
        throw Object.assign(new Error("unique"), { code: "P2002", meta: { target: ["topic", "payloadSha256"] } });
      }
      const receipt: StoredReceipt = {
        id: `receipt-${++nextId}`,
        topic: String(data.topic),
        providerContractId: String(data.providerContractId),
        payloadSha256: digest,
        normalizedPayload: data.normalizedPayload,
        billingOperationId: null,
        processedAt: null,
        processingError: null,
      };
      receipts.push(receipt);
      receiptByDigest.set(key, receipt);
      return { id: receipt.id };
    },
    findUnique: async (args: { where: { topic_payloadSha256: { topic: string; payloadSha256: Uint8Array } } }) => {
      const key = `${args.where.topic_payloadSha256.topic}:${Buffer.from(args.where.topic_payloadSha256.payloadSha256).toString("hex")}`;
      const receipt = receiptByDigest.get(key);
      return receipt ? { id: receipt.id, providerContractId: receipt.providerContractId } : null;
    },
  };
  const logger = createLogger({
    serviceName: "api-webhook-test",
    environment: "test",
    sink: (line) => logLines.push(JSON.stringify(line)),
  });
  const route = createWooBillingWebhookRoute({
    ...(options.apiSecret === undefined ? { apiSecret: secret } : { apiSecret: options.apiSecret }),
    receiptService: new WooBillingWebhookReceiptService(delegate as never),
    logger,
  });
  const runtime = createApiRuntime(
    { ...loadRuntimeConfig({ DATABASE_URL: "postgresql://user:secret@localhost:5432/moda" }), port: 0 },
    { probe: async () => undefined, disconnect: async () => undefined },
    logger,
    undefined,
    route,
  );
  await runtime.start();
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`, receipts, logLines);
  } finally {
    await runtime.shutdown();
  }
}

function signature(body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function post(
  baseUrl: string,
  body: Buffer,
  headers: readonly (readonly [string, string])[],
  path = "/v1/billing/webhooks/woocommerce",
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const socket = connect(Number(url.port), url.hostname);
    const responseChunks: Buffer[] = [];
    socket.on("error", reject);
    socket.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
    socket.on("end", () => {
      const responseText = Buffer.concat(responseChunks).toString("latin1");
      const separator = responseText.indexOf("\r\n\r\n");
      const headerText = separator < 0 ? responseText : responseText.slice(0, separator);
      const bodyText = separator < 0 ? "" : responseText.slice(separator + 4);
      const statusLine = headerText.split("\r\n", 1)[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      const cacheControl = headerText.split("\r\n").find((line) => /^cache-control:/i.test(line))?.split(":", 2)[1]?.trim();
      resolve({ status, cacheControl, body: bodyText });
    });
    socket.on("connect", () => {
      const suppliedLength = headers.find(([name]) => name.toLowerCase() === "content-length")?.[1];
      const requestHeaders = [
        `Host: ${url.host}`,
        ...headers.filter(([name]) => name.toLowerCase() !== "content-length").map(([name, value]) => `${name}: ${value}`),
        `Content-Length: ${suppliedLength ?? body.length}`,
        "Connection: close",
      ];
      socket.write(`POST ${url.pathname}${url.search} HTTP/1.1\r\n${requestHeaders.join("\r\n")}\r\n\r\n`);
      socket.write(body);
    });
  });
}

function validHeaders(body: Buffer): Array<readonly [string, string]> {
  return [
    ["Content-Type", "application/json; charset=utf-8"],
    ["X-WC-Webhook-Topic", topic],
    ["X-WC-Webhook-Signature", signature(body)],
  ];
}

test("public route acknowledges only after storing the signed raw provider payload without tenant state", async () => {
  const rawBody = Buffer.from(basePayload);
  await withWebhookApi(async (baseUrl, receipts, logs) => {
    const result = await post(baseUrl, rawBody, validHeaders(rawBody), `${"/v1/billing/webhooks/woocommerce"}?shopId=caller-selected`);
    assert.equal(result.status, 204);
    assert.equal(result.cacheControl, "no-store");
    assert.equal(result.body, "");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.topic, topic);
    assert.equal(receipts[0]?.providerContractId, "contract-1");
    assert.deepEqual(receipts[0]?.payloadSha256, createHash("sha256").update(rawBody).digest());
    assert.deepEqual(receipts[0]?.normalizedPayload, {
      subscription: { id: "contract-1", status: "active", providerField: "kept" },
    });
    assert.equal(receipts[0]?.billingOperationId, null);
    assert.equal(receipts[0]?.processedAt, null);
    assert.equal(receipts[0]?.processingError, null);
    assert.ok(logs.join("\n").includes("contract-1"));
    assert.ok(!logs.join("\n").includes("must-not-persist"));
  });
});

test("rejects missing, malformed and incorrect signatures before inspecting topic or writing", async () => {
  const rawBody = Buffer.from(basePayload);
  await withWebhookApi(async (baseUrl, receipts) => {
    const missing = await post(baseUrl, rawBody, [["Content-Type", "application/json"], ["X-WC-Webhook-Topic", ""]]);
    const malformed = await post(baseUrl, rawBody, [
      ["Content-Type", "application/json"], ["X-WC-Webhook-Topic", ""], ["X-WC-Webhook-Signature", "%%%"],
    ]);
    const wrong = await post(baseUrl, rawBody, [
      ["Content-Type", "application/json"], ["X-WC-Webhook-Topic", ""], ["X-WC-Webhook-Signature", signature(Buffer.from("different"))],
    ]);
    assert.deepEqual([missing.status, malformed.status, wrong.status], [401, 401, 401]);
    assert.match(missing.body, /invalid_webhook_signature/);
    assert.equal(receipts.length, 0);
  });
});

test("rejects missing, duplicate and unsupported topic headers after body signature verification", async () => {
  const rawBody = Buffer.from(basePayload);
  await withWebhookApi(async (baseUrl, receipts) => {
    const missing = await post(baseUrl, rawBody, [
      ["Content-Type", "application/json"], ["X-WC-Webhook-Signature", signature(rawBody)],
    ]);
    const duplicate = await post(baseUrl, rawBody, [
      ["Content-Type", "application/json"], ["X-WC-Webhook-Signature", signature(rawBody)],
      ["X-WC-Webhook-Topic", topic], ["x-wc-webhook-topic", topic],
    ]);
    const unsupported = await post(baseUrl, rawBody, [
      ["Content-Type", "application/json"], ["X-WC-Webhook-Signature", signature(rawBody)],
      ["X-WC-Webhook-Topic", "unknown.topic"],
    ]);
    assert.equal(missing.status, 400);
    assert.match(missing.body, /invalid_webhook_topic/);
    assert.equal(duplicate.status, 400);
    assert.equal(unsupported.status, 422);
    assert.match(unsupported.body, /unsupported_webhook_topic/);
    assert.equal(receipts.length, 0);
  });
});

test("rejects duplicate signature headers, non-JSON media and encoded bodies without receipt writes", async () => {
  const rawBody = Buffer.from(basePayload);
  await withWebhookApi(async (baseUrl, receipts) => {
    const duplicateSignature = await post(baseUrl, rawBody, [
      ["Content-Type", "application/json"], ["X-WC-Webhook-Topic", topic],
      ["X-WC-Webhook-Signature", signature(rawBody)], ["x-wc-webhook-signature", signature(rawBody)],
    ]);
    const wrongContentType = await post(baseUrl, rawBody, [
      ["Content-Type", "text/plain"], ["X-WC-Webhook-Topic", topic], ["X-WC-Webhook-Signature", signature(rawBody)],
    ]);
    const compressed = await post(baseUrl, rawBody, [
      ["Content-Type", "application/json"], ["Content-Encoding", "gzip"],
      ["X-WC-Webhook-Topic", topic], ["X-WC-Webhook-Signature", signature(rawBody)],
    ]);
    assert.equal(duplicateSignature.status, 401);
    assert.equal(wrongContentType.status, 415);
    assert.match(wrongContentType.body, /unsupported_webhook_content_type/);
    assert.equal(compressed.status, 415);
    assert.match(compressed.body, /unsupported_webhook_content_encoding/);
    assert.equal(receipts.length, 0);
  });
});

test("enforces the 256 KiB stream boundary inclusively and rejects oversized bytes", async () => {
  const json = Buffer.from('{"subscription":{"id":"contract-1","status":"active"}}');
  const exact = Buffer.concat([json, Buffer.alloc(MAX_WOO_BILLING_WEBHOOK_BODY_BYTES - json.length, 0x20)]);
  const oversized = Buffer.concat([exact, Buffer.from(" ")]);
  await withWebhookApi(async (baseUrl, receipts) => {
    const accepted = await post(baseUrl, exact, [
      ...validHeaders(exact), ["Content-Length", String(exact.length)],
    ]);
    const rejected = await post(baseUrl, oversized, [
      ...validHeaders(oversized), ["Content-Length", String(oversized.length)],
    ]);
    assert.equal(accepted.status, 204);
    assert.equal(rejected.status, 413);
    assert.match(rejected.body, /webhook_payload_too_large/);
    assert.equal(receipts.length, 1);
  });
});

test("deduplicates exact signed deliveries and persists byte-distinct raw bodies separately", async () => {
  const rawBody = Buffer.from('{"subscription":{"id":"contract-1","status":"active"}}');
  const whitespaceBody = Buffer.from('{ "subscription" : { "id":"contract-1", "status":"active" } }');
  await withWebhookApi(async (baseUrl, receipts) => {
    const first = await post(baseUrl, rawBody, validHeaders(rawBody));
    const duplicate = await post(baseUrl, rawBody, validHeaders(rawBody));
    const byteDistinct = await post(baseUrl, whitespaceBody, validHeaders(whitespaceBody));
    assert.deepEqual([first.status, duplicate.status, byteDistinct.status], [204, 204, 204]);
    assert.equal(receipts.length, 2);
    assert.notDeepEqual(receipts[0]?.payloadSha256, receipts[1]?.payloadSha256);
  });
});

test("maps receipt persistence failure to retryable 503 without logging body, signature or database details", async () => {
  const rawBody = Buffer.from(basePayload);
  await withWebhookApi(async (baseUrl, receipts, logs) => {
    const result = await post(baseUrl, rawBody, validHeaders(rawBody));
    assert.equal(result.status, 503);
    assert.match(result.body, /webhook_acceptance_unavailable/);
    assert.equal(receipts.length, 0);
    assert.equal(logs.join("\n").includes(secret), false);
    assert.equal(logs.join("\n").includes(signature(rawBody)), false);
    assert.equal(logs.join("\n").includes("must-not-persist"), false);
    assert.equal(logs.join("\n").includes("private"), false);
  }, { failInsert: true });
});

test("fails closed when the accepted API-004 secret is not configured", async () => {
  const rawBody = Buffer.from(basePayload);
  await withWebhookApi(async (baseUrl, receipts) => {
    const result = await post(baseUrl, rawBody, validHeaders(rawBody));
    assert.equal(result.status, 503);
    assert.equal(receipts.length, 0);
  }, { apiSecret: "" });
});