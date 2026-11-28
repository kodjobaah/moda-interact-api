import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { MerchantRecoveryDetailService } from "../../../../../src/merchant/recoveries/detail/read.service.js";
import { isOutreachProjection } from "../../../../../src/merchant/recoveries/detail/outreach-projection.js";
import { MerchantConversationControlService } from "../../../../../src/merchant/conversations/control/service.js";
import { MerchantConversationMessageAdmissionService } from "../../../../../src/merchant/conversations/messages/admission.service.js";
import { MerchantConversationFollowUpService } from "../../../../../src/merchant/conversations/messages/follow-up.service.js";
import { SendHttpError } from "../../../../../src/merchant/conversations/messages/contract.js";
import {
  createPublishedFollowUp,
  LANGUAGE,
  NAME,
  WABA,
  senderReader,
} from "../../conversations/arch047-template-fixture.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

/** Seed historical delivery/compensation evidence through the migrated schema;
 * this tests the read projection, not provider submission or billing writers. */
test(
  "Recovery outreach reads exact physical lineage and late receipts within the authenticated shop",
  {
    skip: !databaseUrl,
  },
  async () => {
    if (!databaseUrl) return;
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const at = new Date(Date.now() - 48 * 3600_000);
    const failedAt = new Date(at.getTime() + 1_000);
    const due = new Date(at.getTime() + 300_000);
    const id = () => randomUUID();
    const hour = 3600_000;
    let clock = new Date(due.getTime() + hour);
    const phone = "123456789124";
    try {
      const shop = await db.shop.create({
        data: {
          domain: `https://woo-${id()}.invalid`,
          platform: "WOOCOMMERCE",
          status: "ACTIVE",
          onboardingCompleted: true,
        },
      });
      const foreignShop = await db.shop.create({
        data: {
          domain: `https://woo-${id()}.invalid`,
          platform: "WOOCOMMERCE",
          status: "ACTIVE",
        },
      });
      const installation = await db.wooCommerceInstallation.create({
        data: {
          shopId: shop.id,
          canonicalSiteUrl: shop.domain,
          credentialDigest: Uint8Array.from(
            createHash("sha256").update(id()).digest(),
          ),
        },
      });
      const principal = {
        shopId: shop.id,
        canonicalSiteUrl: shop.domain,
        installationId: installation.id,
        credentialVersion: installation.credentialVersion,
      };
      const feature = await db.feature.findUniqueOrThrow({
        where: { key: "checkout_recovery" },
      });
      const plan = await db.billingPlan.create({
        data: {
          shopifyPlanHandle: `retry-api-${id()}`,
          name: "Retry API trial",
          kind: "FREE",
          active: true,
          features: { create: [{ featureId: feature.id, enabled: true }] },
        },
      });
      await db.subscription.create({
        data: { shopId: shop.id, status: "ACTIVE", planId: plan.id },
      });
      const recovery = await db.checkoutRecovery.create({
        data: {
          shopId: shop.id,
          checkoutToken: id(),
          lastExternalActivityAt: at,
          status: "MESSAGE_SENT",
          messageSentAt: at,
        },
      });
      const foreign = await db.checkoutRecovery.create({
        data: {
          shopId: foreignShop.id,
          checkoutToken: id(),
          lastExternalActivityAt: at,
        },
      });
      const conversation = await db.conversation.create({
        data: { checkoutRecoveryId: recovery.id, type: "RECOVERY" },
      });
      const recipient = "447700900001";
      const original = await db.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          direction: "OUTBOUND",
          senderType: "AUTOMATION",
          status: "FAILED",
          content: "historical fixture",
          providerMessageId: `wamid.${id()}`,
          sentAt: at,
          failedAt,
          providerFailureCode: "131016",
          dispatchProviderAccountId: WABA,
          dispatchProviderPhoneNumberId: phone,
        },
      });
      // Initial attempts (including initial retries) are not follow-up claims.
      // Match the Background writer: initiatedBy, initiationKey and claimedAt
      // must all be null, rather than supplying only the actor of the message.
      const attempt = await db.recoveryOutreachAttempt.create({
        data: {
          checkoutRecoveryId: recovery.id,
          sequence: 1,
          trigger: "INITIAL",
          status: "FAILED",
          recipient,
          configuredOfferMode: "NONE",
          outboundMessageId: original.id,
          sentAt: at,
          followUpDueAt: at,
        },
      });
      assert.deepEqual(
        [attempt.initiatedBy, attempt.initiationKey, attempt.claimedAt],
        [null, null, null],
      );
      // Seed one already-compensated debit; the DB's deferred guard verifies the
      // exact original/correction/reservation relationship on commit.
      const reservationId = id();
      const sourceKey = createRecoveryIdempotencyKey(
        shop.id,
        `recovery-outreach:${attempt.id}`,
      );
      const reservation = await db.$transaction(async (tx) => {
        const counter = await tx.shopEntitlementCounter.create({
          data: {
            shopId: shop.id,
            counter: "LIFETIME_FREE_RECOVERY_CREDITS",
            grantedQuantity: 2,
          },
        });
        const debit = await tx.usageEvent.create({
          data: {
            shopId: shop.id,
            provider: "WOOCOMMERCE",
            metric: "RECOVERY_CONVERSATION",
            quantity: 1,
            idempotencyKey: createRecoveryIdempotencyKey(shop.id, sourceKey),
            sourceType: "FREE_RECOVERY_RESERVATION",
            sourceId: reservationId,
            occurredAt: at,
          },
        });
        const correction = await tx.usageEvent.create({
          data: {
            shopId: shop.id,
            provider: "WOOCOMMERCE",
            metric: "RECOVERY_CONVERSATION",
            quantity: -1,
            idempotencyKey: `arch028-undelivered:${reservationId}`,
            sourceType: "RECOVERY_UNDELIVERABLE_COMPENSATION",
            sourceId: reservationId,
            correctionOfUsageEventId: debit.id,
            occurredAt: failedAt,
          },
        });
        return tx.usageReservation.create({
          data: {
            id: reservationId,
            shopId: shop.id,
            counterId: counter.id,
            quantity: 1,
            status: "COMMITTED",
            sourceKey,
            committedUsageEventId: debit.id,
            compensationUsageEventId: correction.id,
            compensationReason: "WHATSAPP_DELIVERY_FAILED",
            compensationDisposition: "RESTORED_SPENDABLE",
            compensatedAt: failedAt,
          },
        });
      });
      const intent = await db.recoveryOutreachRetryIntent.create({
        data: {
          failedAttemptId: attempt.id,
          failedMessageId: original.id,
          fundingReservationId: reservation.id,
          providerFailureCode: "131016",
          policy: "AFTER_COOLDOWN",
          notBeforeAt: due,
          expectedGeneration: recovery.generation,
          expectedLastExternalActivityAt: at,
        },
      });
      const read = new MerchantRecoveryDetailService(db);
      const waiting = await read.outreach(principal, recovery.id);
      assert.ok(waiting && isOutreachProjection(waiting));
      assert.equal(waiting.initial.currentSequence, 1);
      assert.equal(waiting.initial.history[0]?.retryDecision, "AFTER_COOLDOWN");
      assert.equal(
        waiting.initial.history[0]?.retryNotBeforeAt,
        due.toISOString(),
      );
      assert.equal(waiting.followUp.state, "MISSING");
      const retry = await db.recoveryOutreachAttempt.create({
        data: {
          id: `retry_${intent.id}`,
          checkoutRecoveryId: recovery.id,
          sequence: 3,
          trigger: "INITIAL",
          status: "PENDING",
          recipient,
          configuredOfferMode: "NONE",
        },
      });
      assert.deepEqual(
        [retry.initiatedBy, retry.initiationKey, retry.claimedAt],
        [null, null, null],
      );
      const claimed = await read.outreach(principal, recovery.id);
      assert.equal(claimed?.initial.currentSequence, 3);
      assert.equal(
        claimed?.initial.history[0]?.retryDecision,
        "SUCCESSOR_CREATED",
      );
      assert.equal(
        claimed?.initial.history[1]?.deliveryState,
        "NO_RECORDED_SUBMISSION",
      );
      // A provider acceptance is seeded as persisted evidence, not as a test
      // call to WhatsApp. The admitted message uses the existing control guard.
      const sent = await db.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          direction: "OUTBOUND",
          senderType: "AUTOMATION",
          status: "SENT",
          content: JSON.stringify({
            contract: "moda.whatsapp.automated-template-parameters.v1",
            recoveryPromise: { kind: "NO_OFFER" },
          }),
          providerMessageId: `wamid.${id()}`,
          sentAt: due,
          providerDispatchKey: `arch046-woo-initial-${createHash("sha256").update(shop.id).update("\0").update(retry.id).digest("hex")}`,
          providerDispatchAdmittedAt: due,
          providerDispatchControlRevision: conversation.controlRevision,
          dispatchProviderAccountId: WABA,
          dispatchProviderPhoneNumberId: phone,
        },
      });
      await db.recoveryOutreachAttempt.update({
        where: { id: retry.id },
        data: {
          status: "WAITING_FOR_RESPONSE",
          outboundMessageId: sent.id,
          sentAt: due,
        },
      });
      const accepted = await read.outreach(principal, recovery.id);
      assert.equal(
        accepted?.initial.history[1]?.deliveryState,
        "PROVIDER_ACCEPTED",
      );
      assert.equal(accepted?.initial.history[1]?.deliveredAt, null);
      // A stale due time on the failed original is not permission to follow up.
      // The API only creates commands, and never manufactures a billing allowance.
      const control = new MerchantConversationControlService(db, () => clock);
      await control.change(principal, conversation.id, {
        targetMode: "HUMAN",
        expectedControlRevision: 0,
      });
      const catalogue = new MerchantConversationFollowUpService(
        db,
        senderReader,
        () => clock,
      );
      const admission = new MerchantConversationMessageAdmissionService(
        db,
        () => clock,
        senderReader,
      );
      const name = `${NAME}_${id().replaceAll("-", "")}`;
      const template = () => ({
        kind: "RECOVERY_FOLLOW_UP_TEMPLATE" as const,
        expectedControlRevision: 1,
        idempotencyKey: id(),
        templateName: name,
        templateLanguage: LANGUAGE,
        templateParameters: [],
      });
      const deny = (code: string) =>
        assert.rejects(
          admission.admit(principal, conversation.id, template()),
          (error) => error instanceof SendHttpError && error.code === code,
        );
      const empty = { schemaVersion: 1, templates: [] };
      assert.deepEqual(await catalogue.read(principal, conversation.id), empty);
      await deny("follow_up_unavailable");
      const inboundAt = new Date(clock.getTime() - 60_000);
      await db.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          direction: "INBOUND",
          senderType: "CUSTOMER",
          providerMessageId: `wamid.${id()}`,
          content: "Customer reply",
          createdAt: inboundAt,
        },
      });
      await deny("service_window_closed");
      const reply = await admission.admit(principal, conversation.id, {
        kind: "HUMAN_TEXT",
        expectedControlRevision: 1,
        idempotencyKey: id(),
        textBody: "Can I help?",
      });
      assert.equal(reply.code, 202);
      assert.equal(
        await db.recoveryOutreachAttempt.count({
          where: { checkoutRecoveryId: recovery.id, sequence: 2 },
        }),
        0,
      );
      assert.equal(
        (await read.summary(principal, recovery.id))?.conversation
          ?.lastInboundAt,
        inboundAt.toISOString(),
      );
      await db.conversationMessage.update({
        where: { id: sent.id },
        data: { status: "DELIVERED", deliveredAt: due },
      });
      assert.equal(
        (await read.outreach(principal, recovery.id))?.initial.history[1]
          ?.deliveryState,
        "DELIVERED",
      );
      clock = new Date(inboundAt.getTime() + 24 * hour); // exact verified window expiry
      await createPublishedFollowUp(db, shop.id, clock, { name });
      const future = new Date(clock.getTime() + 60_000);
      await db.recoveryOutreachAttempt.update({
        where: { id: retry.id },
        data: { followUpDueAt: future },
      });
      assert.deepEqual(await catalogue.read(principal, conversation.id), empty);
      await deny("follow_up_unavailable");
      await db.recoveryOutreachAttempt.update({
        where: { id: retry.id },
        data: { followUpDueAt: clock },
      });
      assert.deepEqual(await catalogue.read(principal, conversation.id), {
        schemaVersion: 1,
        templates: [{ name, language: LANGUAGE }],
      }); // Only the retry contains a valid offer promise.
      const input = template();
      const admitted = await admission.admit(principal, conversation.id, input);
      assert.equal(admitted.code, 202);
      const logical = await db.recoveryOutreachAttempt.findUniqueOrThrow({
        where: {
          checkoutRecoveryId_sequence: {
            checkoutRecoveryId: recovery.id,
            sequence: 2,
          },
        },
      });
      assert.equal(logical.initiatedBy, "HUMAN");
      assert.equal(logical.initiationKey, admitted.response.commandId);
      assert.deepEqual(
        (await read.summary(principal, recovery.id))?.conversation?.followUp,
        { sequence2Used: true, initiatedBy: "HUMAN" },
      );
      assert.equal(
        (await admission.admit(principal, conversation.id, input)).code,
        200,
      );
      await deny("follow_up_unavailable");
      assert.deepEqual(await catalogue.read(principal, conversation.id), empty);
      assert.equal(
        await db.recoveryOutreachAttempt.count({
          where: { checkoutRecoveryId: recovery.id, sequence: 2 },
        }),
        1,
      );
      // Late positive evidence on the original invalidates automated lineage
      // selection but remains visible instead of hiding recorded delivery.
      await db.conversationMessage.update({
        where: { id: original.id },
        data: { status: "READ", readAt: due },
      });
      const conflict = await read.outreach(principal, recovery.id);
      assert.equal(conflict?.initial.state, "CONFLICT");
      assert.equal(conflict?.initial.currentSequence, null);
      assert.equal(conflict?.initial.history[0]?.deliveryState, "READ");
      assert.equal(await read.outreach(principal, foreign.id), null);
      assert.doesNotMatch(
        JSON.stringify(conflict),
        /447700900001|wamid\.|arch046-woo-initial/,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
