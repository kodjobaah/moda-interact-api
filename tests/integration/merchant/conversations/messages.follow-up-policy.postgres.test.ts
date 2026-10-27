import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { digestSecret, randomSecret } from "../../../../src/auth/woo-installation/credential.js";
import { MerchantConversationControlService } from "../../../../src/merchant/conversations/control/service.js";
import { MerchantConversationMessageAdmissionService } from "../../../../src/merchant/conversations/messages/admission.service.js";
import { SendHttpError } from "../../../../src/merchant/conversations/messages/contract.js";
import { createPublishedFollowUp, NAME as BASE_NAME, LANGUAGE, senderReader } from "./arch047-template-fixture.js";

const NAME = `${BASE_NAME}_policy`;
const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const id = () => randomUUID();
const hour = 3600_000;
const minute = 60_000;
const template = () => ({
  kind: "RECOVERY_FOLLOW_UP_TEMPLATE" as const, expectedControlRevision: 1,
  idempotencyKey: id(), templateName: NAME,
  templateLanguage: LANGUAGE, templateParameters: {},
});
const text = () => ({
  kind: "HUMAN_TEXT" as const, expectedControlRevision: 1,
  idempotencyKey: id(), textBody: "Can I help?",
});

test("ARCH-040-API-005 configured Woo follow-up due and verified customer window", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let now = new Date("2026-10-20T18:00:00.000Z");
  try {
    const shop = await db.shop.create({ data: {
      domain: `https://woo-${id()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
      onboardingCompleted: true,
    } });
    const feature = await db.feature.findUniqueOrThrow({ where: { key: "checkout_recovery" } });
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `woo-follow-up-${id()}`, name: "Woo Follow-up", kind: "FREE", active: true,
      features: { create: [{ featureId: feature.id, enabled: true }] },
    } });
    await db.subscription.create({ data: { shopId: shop.id, status: "ACTIVE", planId: plan.id } });
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain,
      credentialDigest: Uint8Array.from(digestSecret(randomSecret())),
    } });
    const principal = { shopId: shop.id, canonicalSiteUrl: shop.domain,
      installationId: installation.id, credentialVersion: installation.credentialVersion };
    await createPublishedFollowUp(db, shop.id, now, { name: NAME });
    const control = new MerchantConversationControlService(db, () => now);
    const admission = new MerchantConversationMessageAdmissionService(db, () => now, senderReader);

    async function recovery(initialAt: Date | null, dueAt: Date | null, shopId = shop.id) {
      const checkout = await db.checkoutRecovery.create({ data: {
        shopId, checkoutToken: id(), lastExternalActivityAt: now,
      } });
      const conversation = await db.conversation.create({ data: {
        checkoutRecoveryId: checkout.id, type: "RECOVERY",
      } });
      let outboundId: string | undefined;
      if (initialAt) {
        const outbound = await db.conversationMessage.create({ data: {
          conversationId: conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION",
          content: "Initial recovery", status: "SENT", sentAt: initialAt, createdAt: initialAt,
        } });
        outboundId = outbound.id;
      }
      const initial = await db.recoveryOutreachAttempt.create({ data: {
        checkoutRecoveryId: checkout.id, sequence: 1, recipient: "447700900001",
        trigger: "INITIAL", status: initialAt ? "WAITING_FOR_RESPONSE" : "PENDING",
        configuredOfferMode: "NONE", sentAt: initialAt, followUpDueAt: dueAt,
        ...(outboundId ? { outboundMessageId: outboundId } : {}),
      } });
      if (shopId === shop.id) await control.change(principal, conversation.id, {
        targetMode: "HUMAN", expectedControlRevision: 0,
      });
      return { checkout, conversation, initial };
    }
    async function inbound(conversationId: string, at: Date, verified = true) {
      return db.conversationMessage.create({ data: {
        conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        content: "Customer reply", createdAt: at,
        ...(verified ? { providerMessageId: `wamid.${id()}` } : {}),
      } });
    }
    async function denied(conversationId: string, code: string, kind: "HUMAN_TEXT" | "TEMPLATE") {
      await assert.rejects(() => admission.admit(principal, conversationId,
        kind === "TEMPLATE" ? template() : text()),
      (error: unknown) => error instanceof SendHttpError && error.code === code);
    }
    async function noClaim(conversationId: string, checkoutRecoveryId: string) {
      assert.equal(await db.merchantConversationSendCommand.count({ where: { conversationId } }), 0);
      assert.equal(await db.recoveryOutreachAttempt.count({ where: {
        checkoutRecoveryId, sequence: 2,
      } }), 0);
    }

    // Short configured delay: no reply, initial outreach only 30 minutes ago.
    // Competing merchants still obtain at most one claim of the SAME attempt.
    const shortAt = new Date(now.getTime() - 30 * minute);
    const short = await recovery(shortAt, new Date(shortAt.getTime() + 10 * minute));
    await denied(short.conversation.id, "service_window_closed", "HUMAN_TEXT");
    const first = template();
    const contender = template();
    const raced = await Promise.allSettled([
      admission.admit(principal, short.conversation.id, first),
      admission.admit(principal, short.conversation.id, contender),
    ]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    const winnerIndex = raced.findIndex((result) => result.status === "fulfilled");
    const winningInput = winnerIndex === 0 ? first : contender;
    const winning = raced[winnerIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof admission.admit>>>;
    assert.equal(winning.value.code, 202);
    const replay = await admission.admit(principal, short.conversation.id, winningInput);
    assert.equal(replay.code, 200);
    assert.equal(replay.response.commandId, winning.value.response.commandId);
    // A replay remains terminal even if the effective due evidence later changes.
    await db.recoveryOutreachAttempt.update({ where: { id: short.initial.id }, data: { followUpDueAt: null } });
    const lateReplay = await admission.admit(principal, short.conversation.id, winningInput);
    assert.equal(lateReplay.code, 200);
    assert.equal(lateReplay.response.commandId, winning.value.response.commandId);
    assert.equal(await db.recoveryOutreachAttempt.count({ where: {
      checkoutRecoveryId: short.checkout.id, sequence: 2,
    } }), 1);
    const claimed = await db.recoveryOutreachAttempt.findUniqueOrThrow({ where: {
      checkoutRecoveryId_sequence: { checkoutRecoveryId: short.checkout.id, sequence: 2 },
    } });
    assert.equal(claimed.initiatedBy, "HUMAN");
    assert.equal(claimed.initiationKey, winningInput.idempotencyKey);
    assert.equal(await db.usageEvent.count({ where: { shopId: shop.id } }), 0);

    // Disabled/unscheduled and future-due policies reject without writing commands.
    for (const due of [null, new Date(now.getTime() + minute)]) {
      const candidate = await recovery(shortAt, due);
      await denied(candidate.conversation.id, "follow_up_unavailable", "TEMPLATE");
      await noClaim(candidate.conversation.id, candidate.checkout.id);
    }
    // A configured long delay is binding even after the initial 24 hours.
    const longAt = new Date(now.getTime() - 30 * hour);
    const longDue = new Date(longAt.getTime() + 36 * hour);
    const long = await recovery(longAt, longDue);
    await denied(long.conversation.id, "follow_up_unavailable", "TEMPLATE");
    await noClaim(long.conversation.id, long.checkout.id);
    now = longDue; // Exactly at the saved due time, the closed-window send is admitted.
    await db.$executeRaw`UPDATE "whatsapp"."WhatsAppTemplateMetaRegistration"
      SET "lastReconciledAt"=${now} WHERE "wabaId"=${"123456789123"}`;
    assert.equal((await admission.admit(principal, long.conversation.id, template())).code, 202);
    now = new Date("2026-10-20T18:00:00.000Z");
    await db.$executeRaw`UPDATE "whatsapp"."WhatsAppTemplateMetaRegistration"
      SET "lastReconciledAt"=${now} WHERE "wabaId"=${"123456789123"}`;

    // Provider-verified inbound opens only the 24-hour free-text window.
    const initialAt = new Date(now.getTime() - 48 * hour);
    const dueAt = new Date(initialAt.getTime() + hour);
    const open = await recovery(initialAt, dueAt);
    await inbound(open.conversation.id, new Date(now.getTime() - 25 * hour));
    await inbound(open.conversation.id, new Date(now.getTime() - 23 * hour));
    await denied(open.conversation.id, "service_window_closed", "TEMPLATE");
    assert.equal((await admission.admit(principal, open.conversation.id, text())).code, 202);
    assert.equal(await db.recoveryOutreachAttempt.count({ where: {
      checkoutRecoveryId: open.checkout.id, sequence: 2,
    } }), 0);

    // The 24-hour interval is half-open: the exact expiry admits a template,
    // and denies free text, provided the configured follow-up is already due.
    const expiry = await recovery(initialAt, dueAt);
    const atBoundary = new Date(now.getTime() - 24 * hour);
    await inbound(expiry.conversation.id, atBoundary);
    await db.recoveryOutreachAttempt.update({ where: { id: expiry.initial.id }, data: {
      status: "ENGAGED", customerRespondedAt: atBoundary,
    } });
    await denied(expiry.conversation.id, "service_window_closed", "HUMAN_TEXT");
    assert.equal((await admission.admit(principal, expiry.conversation.id, template())).code, 202);

    const almostExpired = await recovery(initialAt, dueAt);
    await inbound(almostExpired.conversation.id, new Date(atBoundary.getTime() + 1));
    await denied(almostExpired.conversation.id, "service_window_closed", "TEMPLATE");
    await noClaim(almostExpired.conversation.id, almostExpired.checkout.id);

    const engagedNotDue = await recovery(initialAt, new Date(now.getTime() + minute));
    const oldReply = new Date(now.getTime() - 26 * hour);
    await inbound(engagedNotDue.conversation.id, oldReply);
    await db.recoveryOutreachAttempt.update({ where: { id: engagedNotDue.initial.id }, data: {
      status: "ENGAGED", customerRespondedAt: oldReply,
    } });
    await denied(engagedNotDue.conversation.id, "follow_up_unavailable", "TEMPLATE");
    await noClaim(engagedNotDue.conversation.id, engagedNotDue.checkout.id);

    // An unverified message, an outbound message, a pre-initial inbound or a
    // future-dated inbound cannot open a free-text window or delay a due template.
    const unverified = await recovery(initialAt, dueAt);
    await inbound(unverified.conversation.id, new Date(now.getTime() - minute), false);
    await inbound(unverified.conversation.id, new Date(initialAt.getTime() - minute));
    await inbound(unverified.conversation.id, new Date(now.getTime() + minute));
    await denied(unverified.conversation.id, "service_window_closed", "HUMAN_TEXT");
    assert.equal((await admission.admit(principal, unverified.conversation.id, template())).code, 202);

    // Missing/unsent initial outreach never starts either kind of command.
    const unsent = await recovery(null, null);
    await denied(unsent.conversation.id, "follow_up_unavailable", "TEMPLATE");
    await denied(unsent.conversation.id, "follow_up_unavailable", "HUMAN_TEXT");
    await noClaim(unsent.conversation.id, unsent.checkout.id);
    const absentRecovery = await db.checkoutRecovery.create({ data: {
      shopId: shop.id, checkoutToken: id(), lastExternalActivityAt: now,
    } });
    const absentConversation = await db.conversation.create({ data: {
      checkoutRecoveryId: absentRecovery.id, type: "RECOVERY",
    } });
    await control.change(principal, absentConversation.id, {
      targetMode: "HUMAN", expectedControlRevision: 0,
    });
    await denied(absentConversation.id, "follow_up_unavailable", "TEMPLATE");
    await noClaim(absentConversation.id, absentRecovery.id);

    // API derives tenant from installed Woo credentials, not supplied checkout data.
    const foreignShop = await db.shop.create({ data: {
      domain: `https://woo-${id()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
    } });
    const foreign = await recovery(initialAt, dueAt, foreignShop.id);
    await denied(foreign.conversation.id, "not_found", "TEMPLATE");
    await noClaim(foreign.conversation.id, foreign.checkout.id);
    assert.equal(await db.usageEvent.count({ where: { shopId: shop.id } }), 0);
  } finally {
    await db.$disconnect();
  }
});
