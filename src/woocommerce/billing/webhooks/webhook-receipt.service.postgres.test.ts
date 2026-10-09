import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import { SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS } from "./webhook-payload.js";
import { WooBillingWebhookReceiptService } from "./webhook-receipt.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
const receiptIds: string[] = [];
let prisma: PrismaClient | undefined;

function database(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  return prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

after(async () => {
  if (!prisma) return;
  await prisma.wooCommerceBillingWebhookReceipt.deleteMany({ where: { id: { in: receiptIds } } });
  await prisma.$disconnect();
});

test("PostgreSQL commits webhook receipts and deduplicates only the exact topic and raw-body digest", {
  skip: !databaseUrl,
}, async () => {
  const db = database();
  const service = new WooBillingWebhookReceiptService(db.wooCommerceBillingWebhookReceipt);
  const topic = SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS[0];
  const otherTopic = SUPPORTED_WOO_BILLING_WEBHOOK_TOPICS[1];
  const providerContractId = `api005_contract_${suffix}`;
  const rawBody = Buffer.from(JSON.stringify({ subscription: { id: providerContractId, status: "active" } }));
  const payload = { topic, providerContractId, normalizedPayload: { subscription: { id: providerContractId, status: "active" } } };

  const concurrent = await Promise.all(Array.from({ length: 8 }, () => service.persist({ ...payload, rawBody })));
  assert.equal(concurrent.filter((result) => !result.duplicate).length, 1);
  assert.equal(concurrent.filter((result) => result.duplicate).length, 7);
  assert.equal(new Set(concurrent.map((result) => result.receiptId)).size, 1);
  receiptIds.push(concurrent[0]!.receiptId);

  const exactReceipt = await db.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({
    where: { id: concurrent[0]!.receiptId },
  });
  assert.equal(exactReceipt.topic, topic);
  assert.equal(exactReceipt.providerContractId, providerContractId);
  assert.deepEqual(Buffer.from(exactReceipt.payloadSha256), createHash("sha256").update(rawBody).digest());
  assert.deepEqual(exactReceipt.normalizedPayload, payload.normalizedPayload);
  assert.equal(exactReceipt.billingOperationId, null);
  assert.equal(exactReceipt.processedAt, null);
  assert.equal(exactReceipt.processingError, null);

  const changedBody = Buffer.from(`${rawBody.toString()} `);
  const changedDigest = await service.persist({ ...payload, rawBody: changedBody });
  const changedTopic = await service.persist({ ...payload, topic: otherTopic, rawBody });
  assert.equal(changedDigest.duplicate, false);
  assert.equal(changedTopic.duplicate, false);
  assert.notEqual(changedDigest.receiptId, concurrent[0]!.receiptId);
  assert.notEqual(changedTopic.receiptId, concurrent[0]!.receiptId);
  receiptIds.push(changedDigest.receiptId, changedTopic.receiptId);

  assert.equal(await db.wooCommerceBillingWebhookReceipt.count({ where: { id: { in: receiptIds } } }), 3);
  assert.equal(await db.shop.count(), 0);
  assert.equal(await db.billingOperation.count(), 0);
});