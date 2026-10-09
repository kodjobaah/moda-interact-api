import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { WooBillingWebhookError } from "./webhook-errors.js";
import type { WooBillingWebhookPayload } from "./webhook-payload.js";

type ReceiptDelegate = Pick<PrismaClient["wooCommerceBillingWebhookReceipt"], "create" | "findUnique">;

export interface PersistWooBillingWebhookInput extends WooBillingWebhookPayload {
  rawBody: Buffer;
}

export interface PersistedWooBillingWebhookReceipt {
  receiptId: string;
  duplicate: boolean;
}

export class WooBillingWebhookReceiptService {
  constructor(private readonly receipts: ReceiptDelegate) {}

  async persist(input: PersistWooBillingWebhookInput): Promise<PersistedWooBillingWebhookReceipt> {
    const payloadSha256 = createHash("sha256").update(input.rawBody).digest();
    try {
      const receipt = await this.receipts.create({
        data: {
          topic: input.topic,
          providerContractId: input.providerContractId,
          billingOperationId: null,
          payloadSha256,
          normalizedPayload: input.normalizedPayload as Prisma.InputJsonValue,
          processedAt: null,
          processingError: null,
        },
        select: { id: true },
      });
      return { receiptId: receipt.id, duplicate: false };
    } catch (error) {
      if (!isExactReceiptUniqueConflict(error)) {
        throw new WooBillingWebhookError(503, "webhook_acceptance_unavailable");
      }

      try {
        const existing = await this.receipts.findUnique({
          where: { topic_payloadSha256: { topic: input.topic, payloadSha256 } },
          select: { id: true, providerContractId: true },
        });
        if (!existing || existing.providerContractId !== input.providerContractId) {
          throw new WooBillingWebhookError(500, "webhook_receipt_integrity_error");
        }
        return { receiptId: existing.id, duplicate: true };
      } catch (readError) {
        if (readError instanceof WooBillingWebhookError) throw readError;
        throw new WooBillingWebhookError(503, "webhook_acceptance_unavailable");
      }
    }
  }
}

function isExactReceiptUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") return false;
  if (!("meta" in error) || !error.meta || typeof error.meta !== "object") return false;
  const target = "target" in error.meta ? error.meta.target : undefined;
  if (Array.isArray(target)) {
    return target.length === 2 && target.includes("topic") && target.includes("payloadSha256");
  }
  return target === "WooCommerceBillingWebhookReceipt_topic_payloadSha256_key";
}