import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { digestSecret, randomSecret } from "../../../../src/auth/woo-installation/credential.js";
import { MerchantConversationControlService } from "../../../../src/merchant/conversations/control/service.js";
import { MerchantConversationFollowUpService } from "../../../../src/merchant/conversations/messages/follow-up.service.js";
import { MerchantConversationMessageAdmissionService } from "../../../../src/merchant/conversations/messages/admission.service.js";
import { SendHttpError } from "../../../../src/merchant/conversations/messages/contract.js";
import { createPublishedFollowUp, LANGUAGE, NAME, senderReader, WABA } from "./arch047-template-fixture.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const id = () => randomUUID();
const now = new Date("2026-10-26T12:00:00.000Z");
const input = () => ({ kind: "RECOVERY_FOLLOW_UP_TEMPLATE" as const, expectedControlRevision: 1,
  idempotencyKey: id(), templateName: NAME, templateLanguage: LANGUAGE, templateParameters: [] as string[] });

test("ARCH-047-API-001 tenant-scoped catalogue and fail-closed Meta admission", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const shop = await db.shop.create({ data: { domain: `https://woo-${id()}.invalid`,
      platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true } });
    const otherShop = await db.shop.create({ data: { domain: `https://other-${id()}.invalid`,
      platform: "WOOCOMMERCE", status: "ACTIVE" } });
    const feature = await db.feature.findUniqueOrThrow({ where: { key: "checkout_recovery" } });
    const plan = await db.billingPlan.create({ data: { shopifyPlanHandle: `arch047-${id()}`,
      name: "Arch047 trial", kind: "FREE", active: true,
      features: { create: [{ featureId: feature.id, enabled: true }] } } });
    await db.subscription.create({ data: { shopId: shop.id, status: "ACTIVE", planId: plan.id } });
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain,
      credentialDigest: Uint8Array.from(digestSecret(randomSecret())),
    } });
    const principal = { shopId: shop.id, canonicalSiteUrl: shop.domain,
      installationId: installation.id, credentialVersion: installation.credentialVersion };
    const control = new MerchantConversationControlService(db, () => now);
    async function recovery(shopId: string) {
      const checkout = await db.checkoutRecovery.create({ data: {
        shopId, checkoutToken: id(), lastExternalActivityAt: now,
      } });
      const conversation = await db.conversation.create({ data: {
        checkoutRecoveryId: checkout.id, type: "RECOVERY",
      } });
      return { checkout, conversation };
    }
    const target = await recovery(shop.id);
    const other = await recovery(otherShop.id);
    await control.change(principal, target.conversation.id, { targetMode: "HUMAN", expectedControlRevision: 0 });
    const catalogue = new MerchantConversationFollowUpService(db, senderReader, () => now);
    const admission = new MerchantConversationMessageAdmissionService(db, () => now, senderReader);
    const empty = { schemaVersion: 1, templates: [] };
    assert.deepEqual(await catalogue.read(principal, target.conversation.id), empty);
    await assert.rejects(() => catalogue.read(principal, other.conversation.id),
      (error: unknown) => error instanceof SendHttpError && error.code === "not_found");
    const initialAt = new Date(now.getTime() - 72 * 3600_000);
    const outbound = await db.conversationMessage.create({ data: { conversationId: target.conversation.id,
      direction: "OUTBOUND", senderType: "AUTOMATION", content: "Initial outreach", status: "SENT",
      sentAt: initialAt, createdAt: initialAt } });
    const initial = await db.recoveryOutreachAttempt.create({ data: {
      checkoutRecoveryId: target.checkout.id, sequence: 1, recipient: "447700900001",
      trigger: "INITIAL", status: "WAITING_FOR_RESPONSE", configuredOfferMode: "NONE",
      outboundMessageId: outbound.id, sentAt: initialAt, followUpDueAt: new Date(initialAt.getTime() + 3600_000),
    } });
    assert.deepEqual(await catalogue.read(principal, target.conversation.id), empty);
    await db.recoveryOutreachAttempt.update({ where: { id: initial.id },
      data: { followUpDueAt: new Date(now.getTime() + 60_000) } });
    assert.deepEqual(await catalogue.read(principal, target.conversation.id), empty);
    await db.recoveryOutreachAttempt.update({ where: { id: initial.id },
      data: { followUpDueAt: new Date(initialAt.getTime() + 3600_000) } });
    const inbound = await db.conversationMessage.create({ data: {
      conversationId: target.conversation.id, direction: "INBOUND", senderType: "CUSTOMER",
      content: "Customer reply", providerMessageId: `wamid.${id()}`,
      createdAt: new Date(now.getTime() - 3600_000),
    } });
    assert.deepEqual(await catalogue.read(principal, target.conversation.id), empty);
    await db.conversationMessage.delete({ where: { id: inbound.id } });
    // A prior purpose-only or wrong sender assignment must not be adopted.
    await db.whatsAppTemplateVariant.create({ data: { shopId: shop.id,
      providerAccountId: WABA, purpose: "checkout-recovery", languageTag: "en",
      providerTemplateName: NAME, providerLanguageCode: LANGUAGE, enabled: true, status: "APPROVED" } });
    await createPublishedFollowUp(db, shop.id, now, { wabaId: "999999999999", name: "wrong_sender" });
    assert.deepEqual(await catalogue.read(principal, target.conversation.id), empty);
    const { registrationId, variant } = await createPublishedFollowUp(db, shop.id, now);
    const wrongSender = new MerchantConversationFollowUpService(db,
      { async readMessagingSenderWabaId() { return "987654321987"; } }, () => now);
    assert.deepEqual(await wrongSender.read(principal, target.conversation.id), empty);
    assert.deepEqual(await catalogue.read(principal, target.conversation.id), {
      schemaVersion: 1, templates: [{ name: NAME, language: LANGUAGE }],
    });
    const count = async () => db.merchantConversationSendCommand.count({ where: { conversationId: target.conversation.id } });
    for (const parameters of [["merchant-added-code"], { body: "sneaky" }] as const) {
      await assert.rejects(() => admission.admit(principal, target.conversation.id,
        { ...input(), templateParameters: parameters as never }),
      (error: unknown) => error instanceof SendHttpError && error.code === "invalid_request");
    }
    assert.equal(await count(), 0);
    assert.equal(await db.recoveryOutreachAttempt.count({ where: {
      checkoutRecoveryId: target.checkout.id, sequence: 2,
    } }), 0);
    const unavailable = async () => {
      assert.deepEqual(await catalogue.read(principal, target.conversation.id), empty);
      await assert.rejects(() => admission.admit(principal, target.conversation.id, input()),
        (error: unknown) => error instanceof SendHttpError && error.code === "template_not_allowed");
      assert.equal(await count(), 0);
    };
    await db.$executeRaw`UPDATE "whatsapp"."WhatsAppTemplateMetaRegistration"
      SET "providerStatus"='UNKNOWN' WHERE "id"=${registrationId}`;
    await unavailable();
    await db.$executeRaw`UPDATE "whatsapp"."WhatsAppTemplateMetaRegistration"
      SET "providerStatus"='APPROVED', "driftDetectedAt"=${now} WHERE "id"=${registrationId}`;
    await unavailable();
    await db.$executeRaw`UPDATE "whatsapp"."WhatsAppTemplateMetaRegistration"
      SET "driftDetectedAt"=NULL, "lastReconciledAt"=${new Date(now.getTime() - 3600_001)}
      WHERE "id"=${registrationId}`;
    await unavailable();
    await db.$executeRaw`UPDATE "whatsapp"."WhatsAppTemplateMetaRegistration"
      SET "lastReconciledAt"=${now} WHERE "id"=${registrationId}`;
    await db.$executeRaw`UPDATE "whatsapp"."WhatsAppTemplateVariant"
      SET "enabled"=false WHERE "id"=${variant.id}`;
    await unavailable();
    await db.$executeRaw`UPDATE "whatsapp"."WhatsAppTemplateVariant"
      SET "enabled"=true WHERE "id"=${variant.id}`;
    assert.deepEqual((await catalogue.read(principal, target.conversation.id)).templates,
      [{ name: NAME, language: LANGUAGE }]);
    const fresh = input();
    const one = await admission.admit(principal, target.conversation.id, fresh);
    assert.equal(one.code, 202);
    assert.equal((await admission.admit(principal, target.conversation.id, fresh)).code, 200);
    const command = await db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: one.response.commandId } });
    assert.deepEqual(command.templateParameters, []);
    assert.equal(command.templateName, NAME);
    assert.equal(command.templateLanguageCode, LANGUAGE);
    assert.deepEqual(await catalogue.read(principal, target.conversation.id), empty);
    await assert.rejects(() => admission.admit(principal, target.conversation.id, input()),
      (error: unknown) => error instanceof SendHttpError && error.code === "follow_up_unavailable");
    assert.equal(await db.recoveryOutreachAttempt.count({ where: {
      checkoutRecoveryId: target.checkout.id, sequence: 2,
    } }), 1);
  } finally { await db.$disconnect(); }
});
