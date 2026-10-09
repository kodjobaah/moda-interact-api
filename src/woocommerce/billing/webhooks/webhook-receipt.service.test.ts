import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import test from "node:test";
import { WooBillingWebhookError } from "./webhook-errors.js";
import { WooBillingWebhookReceiptService } from "./webhook-receipt.service.js";

const input = {
  topic: "saas_billing_contract.activated" as const,
  providerContractId: "woo-contract-1",
  normalizedPayload: { subscription: { id: "woo-contract-1", status: "active" } },
  rawBody: Buffer.from('{"subscription":{"id":"woo-contract-1","status":"active"}}'),
};

test("inserts one unprocessed receipt with the exact raw-body digest and null operation", async () => {
  let created: unknown;
  const service = new WooBillingWebhookReceiptService({
    create: async (args: Prisma.WooCommerceBillingWebhookReceiptCreateArgs) => {
      created = args;
      return { id: "receipt-1" };
    },
    findUnique: async () => null,
  } as never);

  assert.deepEqual(await service.persist(input), { receiptId: "receipt-1", duplicate: false });
  assert.deepEqual(created, {
    data: {
      topic: input.topic,
      providerContractId: input.providerContractId,
      billingOperationId: null,
      payloadSha256: createHash("sha256").update(input.rawBody).digest(),
      normalizedPayload: input.normalizedPayload,
      processedAt: null,
      processingError: null,
    },
    select: { id: true },
  });
});

test("recognizes only the exact topic plus raw-digest unique conflict and verifies contract identity", async () => {
  const duplicateConflict = Object.assign(new Error("duplicate"), {
    code: "P2002",
    meta: { target: ["topic", "payloadSha256"] },
  });
  let lookup: unknown;
  const service = new WooBillingWebhookReceiptService({
    create: async () => { throw duplicateConflict; },
    findUnique: async (args: Prisma.WooCommerceBillingWebhookReceiptFindUniqueArgs) => {
      lookup = args;
      return { id: "receipt-1", providerContractId: input.providerContractId };
    },
  } as never);

  assert.deepEqual(await service.persist(input), { receiptId: "receipt-1", duplicate: true });
  assert.deepEqual(lookup, {
    where: {
      topic_payloadSha256: {
        topic: input.topic,
        payloadSha256: createHash("sha256").update(input.rawBody).digest(),
      },
    },
    select: { id: true, providerContractId: true },
  });

  const unrelatedUnique = new WooBillingWebhookReceiptService({
    create: async () => { throw Object.assign(new Error("other unique"), { code: "P2002", meta: { target: ["id"] } }); },
    findUnique: async () => { throw new Error("must not query unrelated unique conflict"); },
  } as never);
  await assert.rejects(unrelatedUnique.persist(input), (error: unknown) =>
    error instanceof WooBillingWebhookError && error.statusCode === 503);
});

test("rejects a duplicate whose signed provider contract identity conflicts with the stored receipt", async () => {
  const service = new WooBillingWebhookReceiptService({
    create: async () => {
      throw Object.assign(new Error("duplicate"), { code: "P2002", meta: { target: ["topic", "payloadSha256"] } });
    },
    findUnique: async () => ({ id: "receipt-1", providerContractId: "different-contract" }),
  } as never);

  await assert.rejects(service.persist(input), (error: unknown) =>
    error instanceof WooBillingWebhookError && error.statusCode === 500 && error.code === "webhook_receipt_integrity_error");
});

test("maps database insert/read failures to retryable bounded acceptance errors", async () => {
  const insertFailure = new WooBillingWebhookReceiptService({
    create: async () => { throw new Error("database details"); },
    findUnique: async () => null,
  } as never);
  await assert.rejects(insertFailure.persist(input), (error: unknown) =>
    error instanceof WooBillingWebhookError && error.statusCode === 503 && error.code === "webhook_acceptance_unavailable");

  const readFailure = new WooBillingWebhookReceiptService({
    create: async () => {
      throw Object.assign(new Error("duplicate"), { code: "P2002", meta: { target: ["topic", "payloadSha256"] } });
    },
    findUnique: async () => { throw new Error("database details"); },
  } as never);
  await assert.rejects(readFailure.persist(input), (error: unknown) =>
    error instanceof WooBillingWebhookError && error.statusCode === 503 && error.code === "webhook_acceptance_unavailable");
});