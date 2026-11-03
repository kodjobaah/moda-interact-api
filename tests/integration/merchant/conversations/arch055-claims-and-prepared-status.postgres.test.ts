import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { digestSecret, randomSecret } from "../../../../src/auth/woo-installation/credential.js";
import { MerchantConversationControlService } from "../../../../src/merchant/conversations/control/service.js";
import { MerchantConversationMessageAdmissionService } from "../../../../src/merchant/conversations/messages/admission.service.js";
import { MerchantConversationSendStatusService } from "../../../../src/merchant/conversations/messages/status.service.js";
import { createPublishedFollowUp, LANGUAGE, NAME, WABA } from "./arch047-template-fixture.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const id = () => randomUUID();
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

test("ARCH-055 isolates human follow-up claims by command and matches prepared text evidence", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const shopIds: string[] = [];
  const failureSuffix = id().replaceAll("-", "");
  const failureFunction = `arch055_reject_command_${failureSuffix}`;
  const failureTrigger = `arch055_reject_command_${failureSuffix}`;
  const now = new Date("2026-11-02T12:00:00.000Z");
  let senderFactoryCalls = 0;
  try {
    const feature = await db.feature.findUniqueOrThrow({ where: { key: "checkout_recovery" } });
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `arch055-claims-${id()}`, name: "ARCH-055 Claims", kind: "FREE", active: true,
      features: { create: [{ featureId: feature.id, enabled: true }] },
    } });
    const shops = [];
    for (let index = 0; index < 2; index += 1) {
      const shop = await db.shop.create({ data: {
        domain: `https://woo-${id()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
        onboardingCompleted: true,
      } });
      shopIds.push(shop.id);
      await db.subscription.create({ data: { shopId: shop.id, status: "ACTIVE", planId: plan.id } });
      const installation = await db.wooCommerceInstallation.create({ data: {
        shopId: shop.id, canonicalSiteUrl: shop.domain,
        credentialDigest: Uint8Array.from(digestSecret(randomSecret())),
      } });
      const recovery = await db.checkoutRecovery.create({ data: {
        shopId: shop.id, checkoutToken: id(), lastExternalActivityAt: now,
      } });
      const conversation = await db.conversation.create({ data: {
        checkoutRecoveryId: recovery.id, type: "RECOVERY",
      } });
      const initialAt = new Date(now.getTime() - 48 * 60 * 60_000);
      const outbound = await db.conversationMessage.create({ data: {
        conversationId: conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION",
        status: "SENT", content: "Initial recovery", sentAt: initialAt, createdAt: initialAt,
      } });
      await db.recoveryOutreachAttempt.create({ data: {
        checkoutRecoveryId: recovery.id, sequence: 1, recipient: "447700900001", trigger: "INITIAL",
        status: "WAITING_FOR_RESPONSE", configuredOfferMode: "NONE", sentAt: initialAt,
        followUpDueAt: new Date(now.getTime() - 60_000), outboundMessageId: outbound.id,
      } });
      const templateName = `${NAME}_${index}`;
      await createPublishedFollowUp(db, shop.id, now, { name: templateName, wabaId: WABA });
      shops.push({ shop, installation, recovery, conversation, templateName });
    }

    const first = shops[0]!;
    const second = shops[1]!;
    const principal = (entry: typeof first) => ({ shopId: entry.shop.id, canonicalSiteUrl: entry.shop.domain,
      installationId: entry.installation.id, credentialVersion: entry.installation.credentialVersion });
    const control = new MerchantConversationControlService(db, () => now);
    await Promise.all(shops.map(entry => control.change(principal(entry), entry.conversation.id, {
      targetMode: "HUMAN", expectedControlRevision: 0,
    })));
    const senderFactory = (tx: unknown) => {
      void tx;
      senderFactoryCalls += 1;
      return { async readMessagingSenderWabaId() { return WABA; } };
    };
    const admission = new MerchantConversationMessageAdmissionService(db, () => now, senderFactory);
    const sharedPublicKey = `same-public-key-${id()}`;
    const templateInput = {
      kind: "RECOVERY_FOLLOW_UP_TEMPLATE" as const, expectedControlRevision: 1,
      idempotencyKey: sharedPublicKey, templateLanguage: LANGUAGE, templateParameters: {},
    };
    const firstInput = { ...templateInput, templateName: first.templateName };
    const secondInput = { ...templateInput, templateName: second.templateName };
    const firstAccepted = await admission.admit(principal(first), first.conversation.id, firstInput);
    const secondAccepted = await admission.admit(principal(second), second.conversation.id, secondInput);
    assert.equal(firstAccepted.code, 202);
    assert.equal(secondAccepted.code, 202);
    assert.notEqual(firstAccepted.response.commandId, secondAccepted.response.commandId);
    const [firstCommand, secondCommand] = await Promise.all([
      db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: firstAccepted.response.commandId } }),
      db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: secondAccepted.response.commandId } }),
    ]);
    assert.equal(firstCommand.idempotencyKey, sharedPublicKey);
    assert.equal(secondCommand.idempotencyKey, sharedPublicKey);
    assert.equal(firstCommand.followUpClaimKey, firstCommand.id);
    assert.equal(secondCommand.followUpClaimKey, secondCommand.id);
    const attempts = await db.recoveryOutreachAttempt.findMany({
      where: { checkoutRecoveryId: { in: [first.recovery.id, second.recovery.id] }, sequence: 2 },
    });
    assert.equal(attempts.length, 2);
    assert.deepEqual(new Set(attempts.map(attempt => attempt.initiationKey)),
      new Set([firstCommand.id, secondCommand.id]));

    const readsBeforeReplay = senderFactoryCalls;
    const replay = await admission.admit(principal(first), first.conversation.id, firstInput);
    assert.equal(replay.code, 200);
    assert.equal(replay.response.commandId, firstCommand.id);
    assert.equal(senderFactoryCalls, readsBeforeReplay);
    assert.equal(await db.recoveryOutreachAttempt.count({
      where: { checkoutRecoveryId: first.recovery.id, sequence: 2 },
    }), 1);

    const humanRecovery = await db.checkoutRecovery.create({ data: {
      shopId: first.shop.id, checkoutToken: id(), lastExternalActivityAt: now,
    } });
    const humanConversation = await db.conversation.create({ data: {
      checkoutRecoveryId: humanRecovery.id, type: "RECOVERY",
    } });
    const humanInitialAt = new Date(now.getTime() - 48 * 60 * 60_000);
    const humanInitial = await db.conversationMessage.create({ data: {
      conversationId: humanConversation.id, direction: "OUTBOUND", senderType: "AUTOMATION",
      status: "SENT", content: "Initial recovery", sentAt: humanInitialAt, createdAt: humanInitialAt,
    } });
    await db.recoveryOutreachAttempt.create({ data: {
      checkoutRecoveryId: humanRecovery.id, sequence: 1, recipient: "447700900001", trigger: "INITIAL",
      status: "WAITING_FOR_RESPONSE", configuredOfferMode: "NONE", sentAt: humanInitialAt,
      outboundMessageId: humanInitial.id,
    } });
    await control.change(principal(first), humanConversation.id, { targetMode: "HUMAN", expectedControlRevision: 0 });
    await db.conversationMessage.create({ data: {
      conversationId: humanConversation.id, direction: "INBOUND", senderType: "CUSTOMER",
      content: "Customer reply", providerMessageId: `wamid.${id()}`,
      createdAt: new Date(now.getTime() - 60_000),
    } });
    const textInput = { kind: "HUMAN_TEXT" as const, expectedControlRevision: 1,
      idempotencyKey: id(), textBody: "Original body" };
    const callsBeforeText = senderFactoryCalls;
    const textAccepted = await admission.admit(principal(first), humanConversation.id, textInput);
    assert.equal(textAccepted.code, 202);
    assert.equal(senderFactoryCalls, callsBeforeText);
    const textCommand = await db.merchantConversationSendCommand.findUniqueOrThrow({
      where: { id: textAccepted.response.commandId },
    });
    assert.equal(textCommand.followUpClaimKey, null);
    const status = new MerchantConversationSendStatusService(db);
    assert.equal((await status.read(principal(first), humanConversation.id, textCommand.id)).moderationStatus,
      "moderation_pending");

    const preparedBody = "Prepared body differs";
    const leaseToken = id();
    const leaseAt = new Date();
    await db.$executeRaw`UPDATE "whatsapp"."MerchantConversationSendCommand"
      SET "state"='CLAIMED',"leaseToken"=${leaseToken},"leaseExpiresAt"=${new Date(leaseAt.getTime() + 60_000)},
        "dispatchAttemptCount"=1,"updatedAt"=${leaseAt}
      WHERE "id"=${textCommand.id} AND "state"='ACCEPTED'`;
    const evidence = { schemaVersion: 1, outcome: "PASSTHROUGH", reason: "PREPARED", bodySha256: sha(preparedBody) };
    await db.$executeRaw`UPDATE "whatsapp"."MerchantConversationSendCommand"
      SET "preparedTextBody"=${preparedBody},"preparedWrapperEvidence"=${JSON.stringify(evidence)}::jsonb,
        "preparedAt"=${leaseAt},"updatedAt"=${leaseAt}
      WHERE "id"=${textCommand.id} AND "state"='CLAIMED' AND "leaseToken"=${leaseToken}
        AND "preparedTextBody" IS NULL`;
    const [assessment] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "whatsapp".arch040_moderation_create_or_reuse(
        ${id()},${first.shop.id},${humanConversation.id},
        'HUMAN_COMMAND'::"whatsapp"."ConversationModerationSubject",NULL,${textCommand.id},
        ${sha(preparedBody)},'TEXT','arch055-test-model','arch055-prepared-v1') AS "id"
    `);
    assert.ok(assessment?.id);
    const moderationLease = id();
    await db.conversationModerationAssessment.update({ where: { id: assessment!.id }, data: {
      decision: "CHECKING", attemptCount: 1, leaseToken: moderationLease,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    } });
    const [completed] = await db.$queryRaw<Array<{ result: boolean }>>(Prisma.sql`
      SELECT "whatsapp".arch040_moderation_complete(${assessment!.id},${moderationLease},
        'BLOCK'::"whatsapp"."ConversationModerationDecision",'arch055-test-model',true,
        '{"harassment":true}'::jsonb,'{"harassment":0.99}'::jsonb,
        'prepared_text_blocked','arch055-test-request',NULL) AS "result"
    `);
    assert.equal(completed?.result, true);
    const preparedStatus = await status.read(principal(first), humanConversation.id, textCommand.id);
    assert.equal(preparedStatus.moderationStatus, "moderation_blocked");

    const rollbackRecovery = await db.checkoutRecovery.create({ data: {
      shopId: first.shop.id, checkoutToken: id(), lastExternalActivityAt: now,
    } });
    const rollbackConversation = await db.conversation.create({ data: {
      checkoutRecoveryId: rollbackRecovery.id, type: "RECOVERY",
    } });
    const rollbackInitial = await db.conversationMessage.create({ data: {
      conversationId: rollbackConversation.id, direction: "OUTBOUND", senderType: "AUTOMATION",
      status: "SENT", content: "Initial recovery", sentAt: humanInitialAt, createdAt: humanInitialAt,
    } });
    await db.recoveryOutreachAttempt.create({ data: {
      checkoutRecoveryId: rollbackRecovery.id, sequence: 1, recipient: "447700900001", trigger: "INITIAL",
      status: "WAITING_FOR_RESPONSE", configuredOfferMode: "NONE", sentAt: humanInitialAt,
      followUpDueAt: new Date(now.getTime() - 60_000), outboundMessageId: rollbackInitial.id,
    } });
    await control.change(principal(first), rollbackConversation.id, {
      targetMode: "HUMAN", expectedControlRevision: 0,
    });
    await db.$executeRawUnsafe(`CREATE FUNCTION public."${failureFunction}"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'ARCH-055 command insert rollback probe'; END;
      $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${failureTrigger}" BEFORE INSERT ON "whatsapp"."MerchantConversationSendCommand"
      FOR EACH ROW EXECUTE FUNCTION public."${failureFunction}"()`);
    const rollbackKey = `rollback-${id()}`;
    await assert.rejects(() => admission.admit(principal(first), rollbackConversation.id, {
      ...firstInput, idempotencyKey: rollbackKey,
    }));
    assert.equal(await db.recoveryOutreachAttempt.count({ where: {
      checkoutRecoveryId: rollbackRecovery.id, sequence: 2,
    } }), 0);
    assert.equal(await db.merchantConversationSendCommand.count({
      where: { shopId: first.shop.id, idempotencyKey: rollbackKey },
    }), 0);
    await db.$executeRawUnsafe(`DROP TRIGGER "${failureTrigger}" ON "whatsapp"."MerchantConversationSendCommand"`);
    await db.$executeRawUnsafe(`DROP FUNCTION public."${failureFunction}"()`);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON "whatsapp"."MerchantConversationSendCommand"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${failureFunction}"()`);
    if (shopIds.length) await db.shop.deleteMany({ where: { id: { in: shopIds } } });
    await db.$disconnect();
  }
});