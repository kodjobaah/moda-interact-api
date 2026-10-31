import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PrismaClient, Prisma } from "@prisma/client";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ConversationControlConflictError, ConversationControlIntegrityError,
  ConversationControlNotFoundError, ConversationControlSuspendedError,
} from "../../../../src/merchant/conversations/control/contract.js";
import { MerchantConversationControlService } from "../../../../src/merchant/conversations/control/service.js";
import { createMerchantConversationControlRoute } from "../../../../src/merchant/conversations/control/routes.js";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { randomSecret, digestSecret, encodeSecret } from "../../../../src/auth/woo-installation/credential.js";

const disposableUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const allowed = (mode: "AI" | "HUMAN", revision: number) => ({ targetMode: mode, expectedControlRevision: revision });
const pending = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
const pendingTurn = (inboundVersion: number, controlRevision: number, startedAt: Date) => ({
  inboundVersion, lastProcessedVersion: Math.max(0, inboundVersion - 1), pendingTurnStartedAt: startedAt,
  pendingAiNotBeforeAt: new Date(startedAt.getTime() + 7 * 60_000),
  pendingAiControlRevision: controlRevision, pendingAiDelayMinutes: 7,
  processingInboundVersion: inboundVersion, processingStartedAt: startedAt,
});
async function assertPendingInvalidated(db: PrismaClient, conversationId: string, inboundVersion: number) {
  const row = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  assert.equal(row.lastProcessedVersion, inboundVersion);
  assert.equal(row.pendingTurnStartedAt, null);
  assert.equal(row.pendingAiNotBeforeAt, null);
  assert.equal(row.pendingAiControlRevision, null);
  assert.equal(row.pendingAiDelayMinutes, null);
  assert.equal(row.processingInboundVersion, null);
  assert.equal(row.processingStartedAt, null);
}

/** This suite runs only on the runner's brand-new PostgreSQL instance and schema. */
test("ARCH-040-API-003 PostgreSQL CAS, immutable audit, Woo auth and restriction ordering", {
  skip: !disposableUrl,
}, async () => {
  if (!disposableUrl) return;
  const db = new PrismaClient({ datasources: { db: { url: disposableUrl } } });
  const shops: string[] = [];
  try {
    const first = await db.shop.create({ data: {
      domain: `https://woo-${randomUUID()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
    } });
    const other = await db.shop.create({ data: {
      domain: `https://woo-${randomUUID()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
    } });
    shops.push(first.id, other.id);
    // PostgreSQL requires each restriction transition to carry a durable,
    // attributable platform-admin audit event in the same transaction.
    const testAdmin = await db.platformAdmin.create({ data: {
      email: `arch040-control-${randomUUID()}@example.invalid`, role: "ADMIN", active: true,
    } });
    const credential = randomSecret();
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: first.id, canonicalSiteUrl: first.domain, credentialDigest: Uint8Array.from(digestSecret(credential)),
    } });
    const principal = { shopId: first.id, canonicalSiteUrl: first.domain,
      installationId: installation.id, credentialVersion: installation.credentialVersion };
    const firstRecovery = await db.checkoutRecovery.create({ data: {
      shopId: first.id, checkoutToken: randomUUID(), lastExternalActivityAt: new Date(),
    } });
    const concurrentRecovery = await db.checkoutRecovery.create({ data: {
      shopId: first.id, checkoutToken: randomUUID(), lastExternalActivityAt: new Date(),
    } });
    const otherRecovery = await db.checkoutRecovery.create({ data: {
      shopId: other.id, checkoutToken: randomUUID(), lastExternalActivityAt: new Date(),
    } });
    const conversation = await db.conversation.create({ data: { checkoutRecoveryId: firstRecovery.id, type: "RECOVERY" } });
    const concurrentConversation = await db.conversation.create({ data: {
      checkoutRecoveryId: concurrentRecovery.id, type: "RECOVERY",
    } });
    const foreign = await db.conversation.create({ data: { checkoutRecoveryId: otherRecovery.id, type: "RECOVERY" } });
    const standalone = await db.conversation.create({ data: { shopId: first.id, type: "PRODUCT_SUPPORT" } });
    assert.equal(conversation.shopId, null, "recovery conversation may have null direct shopId");
    const service = new MerchantConversationControlService(db);
    const initialMessages = await db.conversationMessage.count({ where: { conversationId: conversation.id } });
    const initialAttempts = await db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: firstRecovery.id } });

    await db.conversation.update({ where: { id: conversation.id }, data: pendingTurn(4, 0, new Date()) });
    // The authenticated route resolves its Shop solely from the actual installation
    // bearer and installation ID, never from a supplied shop ID.
    const auth = new WooInstallationAuthenticator(db);
    function request(body: object): IncomingMessage {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
      req.url = `/v1/merchant/conversations/${conversation.id}/control`;
      req.method = "POST";
      req.rawHeaders = ["Content-Type", "application/json", "x-moda-installation-id", installation.id,
        "authorization", `Bearer ${encodeSecret(credential)}`];
      return req;
    }
    function response() {
      let status = 0; let body = "";
      const output = { destroyed: false, headersSent: false,
        writeHead(code: number) { status = code; }, end(value: string) { body = value; },
      } as unknown as ServerResponse;
      return { output, result: () => ({ status, body: JSON.parse(body) as Record<string, unknown> }) };
    }
    const route = createMerchantConversationControlRoute({
      service, authenticator: auth, logger: { info() {}, warn() {}, error() {} } as never,
    });
    const firstHttp = response();
    await route.handle(request(allowed("HUMAN", 0)), firstHttp.output);
    assert.equal(firstHttp.result().status, 200);
    assert.equal(firstHttp.result().body.controlRevision, 1);
    const firstTransition = await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(firstTransition.controlMode, "HUMAN");
    assert.equal(firstTransition.inboundVersion, 4);
    await assertPendingInvalidated(db, conversation.id, 4);

    // Correct-revision same-mode is a read-only no-op; stale replay ALWAYS 409.
    const again = await service.change(principal, conversation.id, allowed("HUMAN", 1));
    assert.equal(again.controlRevision, 1);
    await assertPendingInvalidated(db, conversation.id, 4);
    assert.equal(await db.conversationControlEvent.count({ where: { conversationId: conversation.id } }), 1);
    await assert.rejects(() => service.change(principal, conversation.id, allowed("HUMAN", 0)),
      (error: unknown) => error instanceof ConversationControlConflictError &&
        error.code === "stale_control_revision" && error.current?.controlRevision === 1);

    // Resume AI -> takeover and a second resume, preserving contiguous audit history.
    await db.conversation.update({ where: { id: conversation.id }, data: pendingTurn(5, 0, new Date()) });
    const ai2 = await service.change(principal, conversation.id, allowed("AI", 1));
    await assertPendingInvalidated(db, conversation.id, 5);
    await db.conversation.update({ where: { id: conversation.id }, data: pendingTurn(6, 2, new Date()) });
    const human3 = await service.change(principal, conversation.id, allowed("HUMAN", 2));
    await assertPendingInvalidated(db, conversation.id, 6);
    assert.deepEqual([ai2.controlRevision, human3.controlRevision], [2, 3]);
    const events = await db.conversationControlEvent.findMany({ where: { conversationId: conversation.id },
      orderBy: { toRevision: "asc" } });
    assert.deepEqual(events.map((event) => [event.fromMode, event.toMode, event.fromRevision, event.toRevision]), [
      ["AI", "HUMAN", 0, 1], ["HUMAN", "AI", 1, 2], ["AI", "HUMAN", 2, 3],
    ]);
    assert.deepEqual(events.map((x) => x.occurredAt.getTime()).sort((a,b)=>a-b),
      events.map((x) => x.occurredAt.getTime()), "transition timestamps must be monotonic");
    assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).controlChangedAt?.getTime(),
      events.at(-1)!.occurredAt.getTime());

    // Real concurrency: two independent callers must not both advance rev 3.
    const simultaneous = await Promise.allSettled([
      service.change(principal, conversation.id, allowed("AI", 3)),
      service.change(principal, conversation.id, allowed("AI", 3)),
    ]);
    assert.equal(simultaneous.filter((x) => x.status === "fulfilled").length, 1);
    const loser = simultaneous.find((x) => x.status === "rejected");
    assert.ok(loser?.status === "rejected" && loser.reason instanceof ConversationControlConflictError);
    assert.equal(loser.reason.code, "stale_control_revision");
    assert.equal(await db.conversationControlEvent.count({ where: { conversationId: conversation.id } }), 4);

    // If inbound processing holds the row first, takeover consumes its newest
    // version and clears the pending turn and processing claim after that commit.
    await db.conversation.update({ where: { id: concurrentConversation.id }, data: pendingTurn(1, 0, new Date()) });
    const inboundEntered = pending(); const releaseInbound = pending();
    const inboundAt = new Date();
    const inboundTransaction = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=${concurrentConversation.id} FOR UPDATE`;
      inboundEntered.release();
      await releaseInbound.promise;
      await tx.conversation.update({ where: { id: concurrentConversation.id }, data: {
        inboundVersion: { increment: 1 }, processingInboundVersion: 2, processingStartedAt: inboundAt,
      } });
    });
    await inboundEntered.promise;
    const concurrentTakeover = service.change(principal, concurrentConversation.id, allowed("HUMAN", 0));
    let observedInboundLock = false;
    for (let i = 0; i < 40; i++) {
      const waiting = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS "count"
        FROM pg_stat_activity WHERE datname=current_database()
          AND pid<>pg_backend_pid() AND wait_event_type='Lock'`;
      if ((waiting[0]?.count ?? 0) > 0) { observedInboundLock = true; break; }
      await delay(50);
    }
    releaseInbound.release();
    await inboundTransaction;
    const concurrentResult = await concurrentTakeover;
    assert.equal(observedInboundLock, true, "takeover must wait for the in-flight inbound/claim transaction");
    assert.equal(concurrentResult.controlRevision, 1);
    await assertPendingInvalidated(db, concurrentConversation.id, 2);

    await assert.rejects(() => service.change(principal, foreign.id, allowed("HUMAN", 0)), ConversationControlNotFoundError);
    await assert.rejects(() => service.change(principal, standalone.id, allowed("HUMAN", 0)), ConversationControlNotFoundError);
    await assert.rejects(() => service.change({ ...principal, shopId: other.id }, conversation.id, allowed("AI", 4)),
      WooUnauthenticatedError);
    // Same recovery shop, inconsistent non-null Conversation.shopId must fail closed.
    await db.conversation.update({ where: { id: conversation.id }, data: { shopId: other.id } });
    await assert.rejects(() => service.change(principal, conversation.id, allowed("HUMAN", 4)), ConversationControlIntegrityError);
    await db.conversation.update({ where: { id: conversation.id }, data: { shopId: null } });

    // Administrative suspension must not block an explicit Resume AI.
    const human5 = await service.change(principal, conversation.id, allowed("HUMAN", 4));
    assert.equal(human5.controlRevision, 5);
    await db.$transaction(async (tx) => {
      await tx.shopHumanMessagingRestriction.create({ data: {
        shopId: first.id, status: "SUSPENDED", revision: 1,
        reasonCode: "TEST_SUSPENSION", suspendedAt: new Date(),
      } });
      await tx.shopHumanMessagingRestrictionEvent.create({ data: {
        shopId: first.id, fromStatus: "ACTIVE", toStatus: "SUSPENDED",
        revision: 1, reasonCode: "TEST_SUSPENSION", platformAdminId: testAdmin.id,
      } });
    });
    assert.equal(await db.shopHumanMessagingRestrictionEvent.count({ where: { shopId: first.id } }), 1);
    await assert.rejects(() => service.change(principal, conversation.id, allowed("HUMAN", 5)), ConversationControlSuspendedError);
    const resumed = await service.change(principal, conversation.id, allowed("AI", 5));
    assert.equal(resumed.controlRevision, 6);
    await assert.rejects(() => service.change(principal, conversation.id, allowed("HUMAN", 6)), ConversationControlSuspendedError);

    // The absent-row race uses a second, independently authenticated Woo shop.
    // Removing a restriction while its shop exists is deliberately forbidden by
    // DATABASE-001, so do not delete the first shop's audited suspension.
    const otherInstallation = await db.wooCommerceInstallation.create({ data: {
      shopId: other.id, canonicalSiteUrl: other.domain,
      credentialDigest: Uint8Array.from(digestSecret(randomSecret())),
    } });
    const otherPrincipal = { shopId: other.id, canonicalSiteUrl: other.domain,
      installationId: otherInstallation.id, credentialVersion: otherInstallation.credentialVersion };
    assert.equal(await db.shopHumanMessagingRestriction.count({ where: { shopId: other.id } }), 0);
    const entered = pending(); const held = pending();
    const adminChange = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${other.id} FOR UPDATE`;
      entered.release();
      await held.promise;
      await tx.shopHumanMessagingRestriction.create({ data: {
        shopId: other.id, status: "SUSPENDED", revision: 1,
        reasonCode: "RACE_SUSPENSION", suspendedAt: new Date(),
      } });
      await tx.shopHumanMessagingRestrictionEvent.create({ data: {
        shopId: other.id, fromStatus: "ACTIVE", toStatus: "SUSPENDED",
        revision: 1, reasonCode: "RACE_SUSPENSION", platformAdminId: testAdmin.id,
      } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 });
    await entered.promise;
    const blockedTakeover = service.change(otherPrincipal, foreign.id, allowed("HUMAN", 0));
    // Observe the contender waiting for PostgreSQL's row lock rather than
    // relying only on Promise.all scheduling or an arbitrary sleep.
    let observedLock = false;
    try {
      for (let i = 0; i < 40; i++) {
        const waiting = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS "count"
          FROM pg_stat_activity WHERE datname=current_database()
            AND pid<>pg_backend_pid() AND wait_event_type='Lock'`;
        if ((waiting[0]?.count ?? 0) > 0) { observedLock = true; break; }
        await delay(50);
      }
      assert.equal(observedLock, true, "takeover must contend on the Shop lock while restriction is absent");
    } finally {
      held.release();
    }
    await adminChange;
    await assert.rejects(blockedTakeover, ConversationControlSuspendedError);
    assert.equal(await db.shopHumanMessagingRestrictionEvent.count({ where: { shopId: other.id } }), 1);
    assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: foreign.id } })).controlRevision, 0);
    assert.equal(await db.conversationControlEvent.count({ where: { conversationId: foreign.id } }), 0);

    // Credential rotation and revocation between HTTP auth and transaction fail.
    await db.wooCommerceInstallation.update({ where: { id: installation.id },
      data: { credentialVersion: { increment: 1 }, credentialDigest: Uint8Array.from(digestSecret(randomSecret())) } });
    await assert.rejects(() => service.change(principal, conversation.id, allowed("AI", 6)), WooUnauthenticatedError);
    await assert.rejects(() => auth.authenticate(request(allowed("AI", 6))), WooUnauthenticatedError);
    const rotated = { ...principal, credentialVersion: principal.credentialVersion + 1 };
    const noOp = await service.change(rotated, conversation.id, allowed("AI", 6));
    assert.equal(noOp.controlRevision, 6);
    await db.wooCommerceInstallation.update({ where: { id: installation.id },
      data: { status: "REVOKED", revokedAt: new Date() } });
    await assert.rejects(() => service.change(rotated, conversation.id, allowed("AI", 6)), WooUnauthenticatedError);
    assert.equal(await db.conversationMessage.count({ where: { conversationId: conversation.id } }), initialMessages);
    assert.equal(await db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: firstRecovery.id } }), initialAttempts);
    assert.equal(await db.merchantConversationSendCommand.count({ where: { conversationId: conversation.id } }), 0);
    assert.equal(await db.conversation.count({ where: { checkoutRecoveryId: firstRecovery.id } }), 1);
  } finally {
    if (shops.length) await db.shop.deleteMany({ where: { id: { in: shops } } });
    await db.$disconnect();
  }
});
