import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { PrismaClient, Prisma } from "@prisma/client";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomSecret, encodeSecret, digestSecret } from "../../../../src/auth/woo-installation/credential.js";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { MerchantConversationControlService } from "../../../../src/merchant/conversations/control/service.js";
import { MerchantConversationMessageAdmissionService } from "../../../../src/merchant/conversations/messages/admission.service.js";
import { MerchantConversationSendStatusService } from "../../../../src/merchant/conversations/messages/status.service.js";
import { SendHttpError, type HumanSendInput } from "../../../../src/merchant/conversations/messages/contract.js";
import { createPublishedFollowUp, NAME as BASE_NAME, LANGUAGE, senderReader } from "./arch047-template-fixture.js";
import { createMerchantConversationMessageRoutes } from "../../../../src/merchant/conversations/messages/routes.js";

const NAME = `${BASE_NAME}_service`;
const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const key = () => randomUUID();
const baseText = (id: string, textBody = "Hello, how can I assist you?"): Extract<HumanSendInput, { kind: "HUMAN_TEXT" }> => ({
  kind: "HUMAN_TEXT", expectedControlRevision: 1, idempotencyKey: id, textBody,
});
const baseTemplate = (id: string): Extract<HumanSendInput, { kind: "RECOVERY_FOLLOW_UP_TEMPLATE" }> => ({
  kind: "RECOVERY_FOLLOW_UP_TEMPLATE", expectedControlRevision: 1,
  idempotencyKey: id, templateName: NAME, templateLanguage: LANGUAGE,
  templateParameters: {},
});
function reply() {
  let code = 0, body = "";
  return { raw: { destroyed: false, headersSent: false,
    writeHead(n: number) { code = n; }, end(v: string) { body = v; },
  } as unknown as ServerResponse, value: () => ({ code, body: JSON.parse(body) as Record<string, unknown> }) };
}

test("ARCH-040-API-004 PostgreSQL durable commands, eligibility, moderation and competing claims", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const clock = new Date("2026-10-19T12:00:00.000Z");
    const shop = await db.shop.create({ data: {
      domain: `https://woo-${key()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true,
    } });
    const foreignShop = await db.shop.create({ data: {
      domain: `https://woo-${key()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true,
    } });
    // ARCH-017 already seeds this canonical feature during fresh migrations.
    // Creating it again masks the admission checks behind a unique-key error.
    const checkoutFeature = await db.feature.findUniqueOrThrow({
      where: { key: "checkout_recovery" },
    });
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `woo-free-${key()}`, name: "Woo Free", kind: "FREE", active: true,
      features: { create: [{ featureId: checkoutFeature.id, enabled: true }] },
    } });
    await Promise.all([shop,foreignShop].map((s) => db.subscription.create({ data: {
      shopId: s.id, status: "ACTIVE", planId: plan.id,
    } })));
    const secret = randomSecret();
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain, credentialDigest: Uint8Array.from(digestSecret(secret)),
    } });
    const principal = { shopId: shop.id, canonicalSiteUrl: shop.domain,
      installationId: installation.id, credentialVersion: installation.credentialVersion };
    const createRecovery = async (shopId: string) => {
      const recovery = await db.checkoutRecovery.create({ data: {
        shopId, checkoutToken: key(), lastExternalActivityAt: clock,
      } });
      const conversation = await db.conversation.create({ data: {
        checkoutRecoveryId: recovery.id, type: "RECOVERY",
      } });
      return { recovery, conversation };
    };
    const primary = await createRecovery(shop.id);
    const foreign = await createRecovery(foreignShop.id);
    const standalone = await db.conversation.create({ data: { shopId: shop.id, type: "PRODUCT_SUPPORT" } });
    const initialAt = new Date(clock.getTime() - 72 * 3600_000);
    const outbound = await db.conversationMessage.create({ data: {
      conversationId: primary.conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION",
      status: "SENT", content: "Automated initial recovery", sentAt: initialAt,
      createdAt: initialAt,
    } });
    await db.recoveryOutreachAttempt.create({ data: {
      checkoutRecoveryId: primary.recovery.id, recipient: "447700900001", sequence: 1,
      trigger: "INITIAL", status: "WAITING_FOR_RESPONSE", configuredOfferMode: "NONE",
      outboundMessageId: outbound.id, sentAt: initialAt, followUpDueAt: new Date(initialAt.getTime() + 3600_000),
    } });
    await createPublishedFollowUp(db, shop.id, clock, { name: NAME });
    const control = new MerchantConversationControlService(db, () => clock);
    await control.change(principal, primary.conversation.id, { targetMode: "HUMAN", expectedControlRevision: 0 });
    const service = new MerchantConversationMessageAdmissionService(db, () => clock, senderReader);
    const statusService = new MerchantConversationSendStatusService(db);
    const nothing = { messages: await db.conversationMessage.count({ where: { conversationId: primary.conversation.id } }),
      usage: await db.usageEvent.count({ where: { shopId: shop.id } }) };

    // Cached inbound timestamps alone cannot open HUMAN messaging without a
    // provider-identified persisted CUSTOMER reply.
    await db.conversation.update({ where: { id: primary.conversation.id },
      data: { lastInboundAt: new Date(clock.getTime() - 1_000) } });
    // Without a verified inbound, HUMAN cannot initiate free text.
    await assert.rejects(() => service.admit(principal, primary.conversation.id, baseText(key())),
      (e: unknown) => e instanceof SendHttpError && e.code === "service_window_closed");
    // The next real CUSTOMER webhook establishes service-window proof.
    const inboundAt = new Date(clock.getTime() - 2 * 3600_000);
    await db.conversationMessage.create({ data: {
      conversationId: primary.conversation.id, direction: "INBOUND", senderType: "CUSTOMER",
      content: "Customer reply", providerMessageId: `wamid.${key()}`, createdAt: inboundAt,
    } });
    await db.conversation.update({ where: { id: primary.conversation.id },
      data: { lastInboundAt: inboundAt } });
    const textInput = baseText(key());
    const fresh = await service.admit(principal, primary.conversation.id, textInput);
    assert.equal(fresh.code, 202);
    assert.equal(fresh.response.state, "ACCEPTED");
    assert.equal(fresh.response.kind, "HUMAN_TEXT");
    assert.equal((await service.admit(principal, primary.conversation.id, textInput)).code, 200);
    assert.equal((await service.admit(principal, primary.conversation.id, textInput)).response.commandId, fresh.response.commandId);
    await assert.rejects(() => service.admit(principal, primary.conversation.id,
      { ...textInput, textBody: "changed content" }),
    (e: unknown) => e instanceof SendHttpError && e.code === "idempotency_conflict");
    assert.equal(await db.merchantConversationSendCommand.count({ where: { shopId: shop.id } }), 1);
    assert.equal(await db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: primary.recovery.id } }), 1);
    assert.equal(await db.conversationMessage.count({ where: { conversationId: primary.conversation.id } }), nothing.messages + 1);
    assert.equal(await db.usageEvent.count({ where: { shopId: shop.id } }), nothing.usage);
    const initialStatus = await statusService.read(principal, primary.conversation.id, fresh.response.commandId);
    assert.equal(initialStatus.moderationStatus, "moderation_pending");
    assert.equal(initialStatus.messageId, null);
    const [assessment] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "whatsapp".arch040_moderation_create_or_reuse(${key()},${shop.id},${primary.conversation.id},
        'HUMAN_COMMAND'::"whatsapp"."ConversationModerationSubject",NULL,${fresh.response.commandId},
        ${sha(textInput.textBody)},'TEXT',
        'omni-moderation-latest','moderation-v1') AS "id"`);
    assert.ok(assessment?.id);
    const token = key();
    await db.conversationModerationAssessment.update({ where: { id: assessment!.id }, data: {
      decision: "CHECKING", attemptCount: 1, leaseToken: token, leaseExpiresAt: new Date(Date.now() + 60_000),
    } });
    const [blocked] = await db.$queryRaw<Array<{ result: boolean }>>(Prisma.sql`
      SELECT "whatsapp".arch040_moderation_complete(${assessment!.id},${token},
        'BLOCK'::"whatsapp"."ConversationModerationDecision",'omni-moderation-latest',true,
        '{"harassment":true}'::jsonb,'{"harassment":0.99}'::jsonb,
        'human_content_moderation_blocked','test-provider-request',NULL) AS "result"`);
    assert.equal(blocked?.result, true);
    assert.equal((await statusService.read(principal, primary.conversation.id, fresh.response.commandId)).failureCode,
      "HUMAN_CONTENT_MODERATION_BLOCKED");
    assert.equal((await statusService.read(principal, primary.conversation.id, fresh.response.commandId)).moderationStatus,
      "moderation_blocked");
    await assert.rejects(() => statusService.read(principal, foreign.conversation.id, fresh.response.commandId),
      (e: unknown) => e instanceof SendHttpError && e.code === "not_found");
    await assert.rejects(() => service.admit(principal, foreign.conversation.id, baseText(key())),
      (e: unknown) => e instanceof SendHttpError && e.code === "not_found");
    await assert.rejects(() => service.admit(principal, standalone.id, baseText(key())),
      (e: unknown) => e instanceof SendHttpError && e.code === "not_found");
    await assert.rejects(() => service.admit(principal, primary.conversation.id,
      { ...baseText(key()), expectedControlRevision: 0 }),
      (e: unknown) => e instanceof SendHttpError && e.code === "stale_control_revision");
    await assert.rejects(() => service.admit(principal, primary.conversation.id,
      { ...baseTemplate(key()), templateName: "unapproved_arbitrary" }),
      (e: unknown) => e instanceof SendHttpError && e.code === "service_window_closed");

    // A follow-up is allowed only when 24h elapsed after latest inbound.
    const followUpClock = new Date(inboundAt.getTime() + 24 * 3600_000);
    await db.$executeRaw`UPDATE "whatsapp"."WhatsAppTemplateMetaRegistration"
      SET "lastReconciledAt"=${followUpClock} WHERE "wabaId"=${"123456789123"}`;
    const followupService = new MerchantConversationMessageAdmissionService(db,
      () => followUpClock, senderReader);
    await assert.rejects(() => followupService.admit(principal, primary.conversation.id,
      { ...baseTemplate(key()), templateName: "unapproved_arbitrary" }),
      (e: unknown) => e instanceof SendHttpError && e.code === "template_not_allowed");
    await assert.rejects(() => followupService.admit(principal, primary.conversation.id, baseText(key())),
      (e: unknown) => e instanceof SendHttpError && e.code === "service_window_closed");
    const followup = baseTemplate(key());
    const two = await Promise.allSettled([
      followupService.admit(principal, primary.conversation.id, followup),
      followupService.admit(principal, primary.conversation.id, { ...followup, idempotencyKey: key() }),
    ]);
    assert.equal(two.filter((r) => r.status === "fulfilled").length, 1);
    const winning = two.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof followupService.admit>>>;
    assert.equal(winning.value.response.kind, "RECOVERY_FOLLOW_UP_TEMPLATE");
    const attempt = await db.recoveryOutreachAttempt.findUniqueOrThrow({ where: {
      checkoutRecoveryId_sequence: { checkoutRecoveryId: primary.recovery.id, sequence: 2 },
    } });
    assert.equal(attempt.initiatedBy, "HUMAN");
    assert.equal(attempt.status, "PENDING");
    assert.equal(await db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: primary.recovery.id, sequence: 2 } }), 1);
    const command = await db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: winning.value.response.commandId } });
    assert.equal(command.recoveryOutreachAttemptId, attempt.id);
    assert.equal(attempt.initiationKey, command.idempotencyKey);
    assert.equal(await db.conversation.count({ where: { checkoutRecoveryId: primary.recovery.id } }), 1);
    assert.equal(await db.usageEvent.count({ where: { shopId: shop.id } }), nothing.usage);
    if (command.idempotencyKey === followup.idempotencyKey) {
      const replay = await followupService.admit(principal, primary.conversation.id, followup);
      assert.equal(replay.code, 200);
    } else {
      await assert.rejects(() => followupService.admit(principal, primary.conversation.id, followup),
        (e: unknown) => e instanceof SendHttpError && e.code === "follow_up_unavailable");
    }

    // Simulate the BG002 scheduled producer winning the Shop -> Conversation
    // lock before a competing merchant takeover. The API must not claim or
    // create another sequence-two row after the scheduler has committed.
    const raced = await createRecovery(shop.id);
    const racedOutbound = await db.conversationMessage.create({ data: {
      conversationId: raced.conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION",
      content: "Recovery first-contact", status: "SENT", sentAt: initialAt, createdAt: initialAt,
    } });
    await db.recoveryOutreachAttempt.create({ data: {
      checkoutRecoveryId: raced.recovery.id, sequence: 1, recipient: "447700900001",
      trigger: "INITIAL", status: "WAITING_FOR_RESPONSE", configuredOfferMode: "NONE",
      sentAt: initialAt, outboundMessageId: racedOutbound.id,
    } });
    let entered!: () => void, release!: () => void;
    const holding = new Promise<void>((r) => { entered=r; });
    const resume = new Promise<void>((r) => { release=r; });
    const scheduled = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${shop.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=${raced.conversation.id} FOR UPDATE`;
      const mode = await tx.conversation.findUniqueOrThrow({ where: { id: raced.conversation.id }, select: { controlMode: true } });
      assert.equal(mode.controlMode, "AI");
      entered(); await resume;
      await tx.recoveryOutreachAttempt.create({ data: {
        checkoutRecoveryId: raced.recovery.id, sequence: 2, recipient: "447700900001",
        trigger: "NO_RESPONSE_FOLLOW_UP", status: "PENDING", configuredOfferMode: "NONE",
        initiatedBy: "AUTOMATION", initiationKey: `scheduled-no-response:${raced.recovery.id}`,
        claimedAt: clock,
      } });
    });
    await holding;
    const takeover = control.change(principal, raced.conversation.id, { targetMode: "HUMAN", expectedControlRevision: 0 });
    release();
    await Promise.all([scheduled,takeover]);
    await assert.rejects(() => service.admit(principal, raced.conversation.id, baseTemplate(key())),
      (e: unknown) => e instanceof SendHttpError && e.code === "follow_up_unavailable");
    const racedAttempt = await db.recoveryOutreachAttempt.findUniqueOrThrow({ where: {
      checkoutRecoveryId_sequence: { checkoutRecoveryId: raced.recovery.id, sequence: 2 },
    } });
    assert.equal(racedAttempt.initiatedBy, "AUTOMATION");
    assert.equal(await db.merchantConversationSendCommand.count({ where: { conversationId: raced.conversation.id } }), 0);
    assert.equal(await db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: raced.recovery.id, sequence: 2 } }), 1);

    // Audit-backed suspension fences the absent restriction-row case. A denied
    // HUMAN request must not create another command/sequence-two attempt.
    const admin = await db.platformAdmin.create({ data: {
      email: `api004-${key()}@example.invalid`, role: "ADMIN", active: true,
    } });
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${shop.id} FOR UPDATE`;
      await tx.shopHumanMessagingRestriction.create({ data: {
        shopId: shop.id, status: "SUSPENDED", revision: 1, reasonCode: "TEST_SUSPENSION",
        suspendedAt: new Date(),
      } });
      await tx.shopHumanMessagingRestrictionEvent.create({ data: {
        shopId: shop.id, fromStatus: "ACTIVE", toStatus: "SUSPENDED", revision: 1,
        reasonCode: "TEST_SUSPENSION", platformAdminId: admin.id,
      } });
    });
    await assert.rejects(() => service.admit(principal, primary.conversation.id, baseText(key())),
      (e: unknown) => e instanceof SendHttpError && e.code === "human_messaging_suspended");
    assert.equal(await db.merchantConversationSendCommand.count({ where: { shopId: shop.id } }), 2);
    // A real credential rotation replaces the digest as well as incrementing
    // the version. Incrementing only the version does not revoke the bearer:
    // the authenticator reads the current version after validating the digest.
    const rotatedSecret = randomSecret();
    await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: {
      credentialVersion: { increment: 1 },
      credentialDigest: Uint8Array.from(digestSecret(rotatedSecret)),
    } });
    await assert.rejects(() => service.admit(principal, primary.conversation.id, baseText(key())), WooUnauthenticatedError);
    assert.equal(await db.merchantConversationSendCommand.count({ where: { shopId: shop.id } }), 2);
    // Verify the old bearer is rejected by the real route, while the rotated
    // bearer can still read the existing command and its moderation status.
    const authenticate = new WooInstallationAuthenticator(db);
    const route = createMerchantConversationMessageRoutes({
      authenticator: authenticate, admission: service, status: statusService,
      followUp: { async read() { return { schemaVersion: 1, templates: [] }; } } as never,
      logger: { info() {}, warn() {}, error() {} } as never,
    });
    const statusRequest = (credential: Uint8Array): IncomingMessage => {
      const req = Readable.from([]) as IncomingMessage;
      req.method = "GET";
      req.url = `/v1/merchant/conversations/${primary.conversation.id}/send-commands/${fresh.response.commandId}`;
      req.rawHeaders = ["x-moda-installation-id", installation.id, "authorization", `Bearer ${encodeSecret(credential)}`];
      return req;
    };
    const oldBearer = reply(); await route.handle(statusRequest(secret), oldBearer.raw);
    assert.equal(oldBearer.value().code, 401);
    assert.equal(oldBearer.value().body.error, "unauthorized");
    const currentBearer = reply(); await route.handle(statusRequest(rotatedSecret), currentBearer.raw);
    assert.equal(currentBearer.value().code, 200);
    assert.equal(currentBearer.value().body.commandId, fresh.response.commandId);
    assert.equal(currentBearer.value().body.moderationStatus, "moderation_blocked");
    console.log("PASS merchant command idempotency, moderation status, Woo auth, human window and sequence-two contention");
  } finally { await db.$disconnect(); }
});
