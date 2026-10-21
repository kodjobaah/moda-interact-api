import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { MerchantRecoveryDetailService } from "../../../../../src/merchant/recoveries/detail/read.service.js";

/** Runs only in the disposable PostgreSQL database established by the test harness.
 * D005's database guard and checksum function are deliberately exercised for real.
 */
const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
test("ARCH-040-API-002 Woo Recovery Detail saved basket, verified window and current moderation", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const id = () => randomUUID();
  const now = new Date();
  try {
    const shop = await db.shop.create({ data: {
      domain: `https://woo-${id()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
    } });
    const foreignShop = await db.shop.create({ data: {
      domain: `https://woo-${id()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
    } });
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain,
      credentialDigest: Uint8Array.from(createHash("sha256").update(id()).digest()),
    } });
    const principal = { shopId: shop.id, canonicalSiteUrl: shop.domain,
      installationId: installation.id, credentialVersion: installation.credentialVersion };
    const checkout = await db.checkoutRecovery.create({ data: {
      shopId: shop.id, checkoutToken: id(), lastExternalActivityAt: now,
      currency: "GBP", totalPrice: new Prisma.Decimal("9876543.210005"),
      lineItems: [
        { title: "Jumper", variantTitle: "Blue Large", quantity: 2, price: "12.3400", sku: "private-sku" },
        { title: "Hat", variantTitle: null, quantity: 1, price: "0.01" },
      ],
    } });
    const conversation = await db.conversation.create({ data: {
      checkoutRecoveryId: checkout.id, type: "RECOVERY", controlMode: "HUMAN", controlRevision: 7,
      controlChangedAt: now,
    } });
    assert.equal(conversation.shopId, null, "recovery-linked conversation need not have direct shopId");
    const initialAt = new Date(now.getTime() - 48 * 3600_000);
    const initialMessage = await db.conversationMessage.create({ data: {
      conversationId: conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION",
      content: "Initial outreach", createdAt: initialAt, sentAt: initialAt, status: "SENT",
    } });
    await db.recoveryOutreachAttempt.create({ data: {
      checkoutRecoveryId: checkout.id, sequence: 1, recipient: "447700900001", trigger: "INITIAL",
      status: "WAITING_FOR_RESPONSE", configuredOfferMode: "NONE", sentAt: initialAt,
      outboundMessageId: initialMessage.id,
    } });
    const verifiedAt = new Date(now.getTime() - 23 * 3600_000);
    const verified = await db.conversationMessage.create({ data: {
      conversationId: conversation.id, direction: "INBOUND", senderType: "CUSTOMER",
      content: "Help me with my order", createdAt: verifiedAt,
      providerMessageId: `wamid.${id()}`,
    } });
    await db.conversationMessage.create({ data: {
      conversationId: conversation.id, direction: "INBOUND", senderType: "CUSTOMER",
      content: "Unverified inbound", createdAt: new Date(now.getTime() - 3600_000),
    } });
    // D005 itself verifies subject tenant and digest; no provider/model calls.
    const created = await db.$queryRaw<Array<{ assessmentId: string }>>(Prisma.sql`
      SELECT "whatsapp".arch040_moderation_create_or_reuse(
        ${id()},${shop.id},${conversation.id},
        'CUSTOMER_MESSAGE'::"whatsapp"."ConversationModerationSubject",
        ${verified.id},${null},
        ${createHash("sha256").update(verified.content, "utf8").digest("hex")},
        'TEXT','disposable-test-model','arch040-api002-v1'
      ) AS "assessmentId"
    `);
    assert.ok(created[0]?.assessmentId);
    const read = new MerchantRecoveryDetailService(db);
    const detail = await read.summary(principal, checkout.id);
    assert.equal(detail?.basket.recoveryTotal.amount, "9876543.210005");
    assert.equal(detail?.basket.items[0]?.unitPrice?.amount, "12.3400");
    assert.equal(detail?.basket.items[0]?.lineTotal, null);
    assert.equal(detail?.basket.items[0]?.imageUrl, null);
    assert.equal(detail?.conversation?.controlRevision, 7);
    assert.equal(detail?.conversation?.lastInboundAt, verifiedAt.toISOString());
    assert.equal(detail?.conversation?.windowExpiresAt,
      new Date(verifiedAt.getTime() + 24 * 3600_000).toISOString());
    assert.equal(detail?.humanMessagingStatus, "ACTIVE");
    const page = await read.messages(principal, checkout.id, new URLSearchParams());
    assert.equal(page?.items.find((message) => message.id === verified.id)?.moderationStatus, "PENDING");
    assert.equal(page?.items.find((message) => message.id === verified.id)?.moderationReasonCode, null);
    assert.equal(page?.items.length, 3);
    const foreign = await db.checkoutRecovery.create({ data: {
      shopId: foreignShop.id, checkoutToken: id(), lastExternalActivityAt: now,
    } });
    assert.equal(await read.summary(principal, foreign.id), null);
    const missingBasket = await db.checkoutRecovery.create({ data: {
      shopId: shop.id, checkoutToken: id(), lastExternalActivityAt: now,
    } });
    const without = await read.summary(principal, missingBasket.id);
    assert.equal(without?.basket.unavailableReason, "missing_snapshot");
    assert.equal(without?.conversation, null);
    const saved = await db.checkoutRecovery.update({ where: { id: missingBasket.id }, data: {
      lineItems: { unsupported: ["raw"] },
    } });
    assert.ok(saved);
    assert.equal((await read.summary(principal, missingBasket.id))?.basket.unavailableReason, "invalid_snapshot");
  } finally {
    await db.$disconnect();
  }
});
