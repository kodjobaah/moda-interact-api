import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { encryptCredential, parseCredentialKeyring } from
  "@modainteract/moda-interact-shared/security/credentials/node";
import { digestSecret, randomSecret } from "../../../../src/auth/woo-installation/credential.js";
import { MerchantConversationControlService } from "../../../../src/merchant/conversations/control/service.js";
import { MerchantConversationMessageAdmissionService } from "../../../../src/merchant/conversations/messages/admission.service.js";
import { MerchantConversationSendStatusService } from "../../../../src/merchant/conversations/messages/status.service.js";
import { createTransactionMessagingSenderFactory, type TransactionConfigurationDatabase } from
  "../../../../src/platform-configuration/composition.js";
import { apiPlatformConfigurationAad } from "../../../../src/platform-configuration/contracts.js";
import { createPublishedFollowUp, LANGUAGE, NAME, WABA } from "./arch047-template-fixture.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const id = () => randomUUID();
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

interface M07Counters {
  logicalClientCalls: number;
  transactionCalls: number;
  transactionElapsedMs: number[];
  delegateCalls: Record<string, number>;
}

function instrumentTransactionClient(tx: Prisma.TransactionClient, counters: M07Counters): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof property === "string" && property.startsWith("$") && typeof value === "function") {
        return (...args: unknown[]) => {
          counters.logicalClientCalls += 1;
          counters.delegateCalls[property] = (counters.delegateCalls[property] ?? 0) + 1;
          return Reflect.apply(value, target, args);
        };
      }
      if (typeof property === "string" && value !== null && typeof value === "object") {
        return new Proxy(value, {
          get(delegate, method) {
            const member = Reflect.get(delegate, method, delegate) as unknown;
            if (typeof member !== "function") return member;
            return (...args: unknown[]) => {
              counters.logicalClientCalls += 1;
              const label = `${property}.${String(method)}`;
              counters.delegateCalls[label] = (counters.delegateCalls[label] ?? 0) + 1;
              return Reflect.apply(member, delegate, args);
            };
          },
        });
      }
      return value;
    },
  });
}

function instrumentDatabase(database: PrismaClient, counters: M07Counters): Pick<PrismaClient, "$transaction"> {
  return new Proxy(database, {
    get(target, property) {
      if (property === "$transaction") {
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => {
          counters.transactionCalls += 1;
          const startedAt = performance.now();
          return target.$transaction(async tx => callback(instrumentTransactionClient(tx, counters)), options as never)
            .finally(() => counters.transactionElapsedMs.push(performance.now() - startedAt));
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof property === "string" && property.startsWith("$") && typeof value === "function") {
        return (...args: unknown[]) => {
          counters.logicalClientCalls += 1;
          counters.delegateCalls[property] = (counters.delegateCalls[property] ?? 0) + 1;
          return Reflect.apply(value, target, args);
        };
      }
      if (typeof property === "string" && value !== null && typeof value === "object") {
        return new Proxy(value, {
          get(delegate, method) {
            const member = Reflect.get(delegate, method, delegate) as unknown;
            if (typeof member !== "function") return member;
            return (...args: unknown[]) => {
              counters.logicalClientCalls += 1;
              const label = `${property}.${String(method)}`;
              counters.delegateCalls[label] = (counters.delegateCalls[label] ?? 0) + 1;
              return Reflect.apply(member, delegate, args);
            };
          },
        });
      }
      return value;
    },
  }) as Pick<PrismaClient, "$transaction">;
}

function m07Counters(): M07Counters {
  return { logicalClientCalls: 0, transactionCalls: 0, transactionElapsedMs: [], delegateCalls: {} };
}

function normalizeSql(query: string): string {
  return query.replace(/\$\d+/g, "?").replace(/\s+/g, " ").trim();
}

test("ARCH-055 isolates human follow-up claims by command and matches prepared text evidence", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "2");
  const statements: Array<{ query: string; durationMs: number }> = [];
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } },
    log: [{ emit: "event", level: "query" }] });
  db.$on("query", event => statements.push({ query: event.query, durationMs: event.duration }));
  const shopIds: string[] = [];
  const failureSuffix = id().replaceAll("-", "");
  const failureFunction = `arch055_reject_command_${failureSuffix}`;
  const failureTrigger = `arch055_reject_command_${failureSuffix}`;
  const now = new Date("2026-11-02T12:00:00.000Z");
  let senderFactoryCalls = 0;
  const wrappingJson = JSON.stringify({ wrapping: randomBytes(32).toString("base64") });
  const keyring = parseCredentialKeyring(wrappingJson);
  const unsealEnvironment = {
    MODA_ENCRYPTION_KEYS_JSON: wrappingJson,
    MODA_ENCRYPTION_ACTIVE_KEY_ID: "wrapping",
  };
  const senderSecret = { accessToken: "not-a-real-provider-token", phoneNumberId: "1234567890",
    businessAccountId: WABA };
  const encrypted = encryptCredential({ keyring, activeKeyId: "wrapping",
    plaintext: JSON.stringify(senderSecret), aad: apiPlatformConfigurationAad("test", "messaging.sender", 1) });
  const sealedValue = { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM",
    wrappingKeyId: encrypted.keyId, nonce: Buffer.from(encrypted.nonce).toString("base64"),
    ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
    authTag: Buffer.from(encrypted.authTag).toString("base64") };
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
    await db.platformConfiguration.create({ data: { environment: "test", key: "messaging.sender", value: sealedValue } });

    const first = shops[0]!;
    const second = shops[1]!;
    const principal = (entry: typeof first) => ({ shopId: entry.shop.id, canonicalSiteUrl: entry.shop.domain,
      installationId: entry.installation.id, credentialVersion: entry.installation.credentialVersion });
    const control = new MerchantConversationControlService(db, () => now);
    await Promise.all(shops.map(entry => control.change(principal(entry), entry.conversation.id, {
      targetMode: "HUMAN", expectedControlRevision: 0,
    })));
    const configuredFactory = createTransactionMessagingSenderFactory({ environment: "test", unsealEnvironment });
    let senderReaderCalls = 0;
    const senderFactory = (tx: TransactionConfigurationDatabase) => {
      senderFactoryCalls += 1;
      const reader = configuredFactory(tx);
      return { readMessagingSenderWabaId: async () => {
        senderReaderCalls += 1;
        return reader.readMessagingSenderWabaId();
      } };
    };
    const admission = new MerchantConversationMessageAdmissionService(db, () => now, senderFactory);

    if (process.env.ARCH055_MEASURE_VERSION) {
      const sourceRoot = process.env.ARCH055_SOURCE_ROOT;
      const admissionModule = sourceRoot
        ? await import(pathToFileURL(resolve(sourceRoot,
          "src/merchant/conversations/messages/admission.service.js")).href)
        : { MerchantConversationMessageAdmissionService };
      const statusModule = sourceRoot
        ? await import(pathToFileURL(resolve(sourceRoot,
          "src/merchant/conversations/messages/status.service.js")).href)
        : { MerchantConversationSendStatusService };
      const AdmissionService = admissionModule.MerchantConversationMessageAdmissionService as
        typeof MerchantConversationMessageAdmissionService;
      const StatusService = statusModule.MerchantConversationSendStatusService as
        typeof MerchantConversationSendStatusService;
      let measuredSender: unknown = senderFactory;
      if (sourceRoot) {
        const configurationModule = await import(pathToFileURL(resolve(sourceRoot,
          "src/platform-configuration/composition.js")).href);
        const baselineReader = configurationModule.createApiPlatformConfigurationReader({
          prisma: db, environment: "test", unsealEnvironment,
        });
        measuredSender = { readMessagingSenderWabaId: async () => {
          senderReaderCalls += 1;
          return baselineReader.readMessagingSenderWabaId();
        } };
      }
      type MeasurementFixture = {
        recoveryId: string;
        conversationId: string;
        idempotencyKey: string;
        commandId?: string;
        input: { kind: "HUMAN_TEXT"; expectedControlRevision: number; idempotencyKey: string; textBody: string } |
          { kind: "RECOVERY_FOLLOW_UP_TEMPLATE"; expectedControlRevision: number; idempotencyKey: string;
            templateName: string; templateLanguage: string; templateParameters: Record<string, never> };
      };
      const createMeasurementFixture = async (kind: "text" | "template", sample: number): Promise<MeasurementFixture> => {
        const recoveryId = `arch055_m07_${kind}_recovery_${sample}`;
        const conversationId = `arch055_m07_${kind}_conversation_${sample}`;
        const sentAt = new Date(now.getTime() - 48 * 60 * 60_000);
        const idempotencyKey = `arch055-m07-${kind}-${sample}`;
        const recovery = await db.checkoutRecovery.create({ data: {
          id: recoveryId, shopId: first.shop.id, checkoutToken: idempotencyKey,
          lastExternalActivityAt: now,
        } });
        const conversation = await db.conversation.create({ data: {
          id: conversationId, checkoutRecoveryId: recovery.id, type: "RECOVERY",
        } });
        const initial = await db.conversationMessage.create({ data: {
          id: `arch055_m07_${kind}_initial_${sample}`, conversationId: conversation.id,
          direction: "OUTBOUND", senderType: "AUTOMATION", status: "SENT", content: "Initial recovery",
          sentAt, createdAt: sentAt,
        } });
        await db.recoveryOutreachAttempt.create({ data: {
          id: `arch055_m07_${kind}_attempt_${sample}`, checkoutRecoveryId: recovery.id,
          sequence: 1, recipient: "447700900001", trigger: "INITIAL", status: "WAITING_FOR_RESPONSE",
          configuredOfferMode: "NONE", sentAt, followUpDueAt: new Date(now.getTime() - 60_000),
          outboundMessageId: initial.id,
        } });
        await control.change(principal(first), conversation.id, {
          targetMode: "HUMAN", expectedControlRevision: 0,
        });
        if (kind === "text") {
          await db.conversationMessage.create({ data: {
            id: `arch055_m07_text_inbound_${sample}`, conversationId: conversation.id,
            direction: "INBOUND", senderType: "CUSTOMER", content: "Customer reply",
            providerMessageId: `wamid.arch055.m07.${sample}`, createdAt: new Date(now.getTime() - 60_000),
          } });
          return { recoveryId, conversationId, idempotencyKey, input: {
            kind: "HUMAN_TEXT", expectedControlRevision: 1, idempotencyKey, textBody: `M07 text ${sample}`,
          } };
        }
        return { recoveryId, conversationId, idempotencyKey, input: {
          kind: "RECOVERY_FOLLOW_UP_TEMPLATE", expectedControlRevision: 1, idempotencyKey,
          templateName: first.templateName, templateLanguage: LANGUAGE, templateParameters: {},
        } };
      };
      const stateSnapshot = async (fixture: MeasurementFixture, commandId?: string) => {
        const command = await db.merchantConversationSendCommand.findUnique({
          where: { shopId_idempotencyKey: { shopId: first.shop.id, idempotencyKey: fixture.idempotencyKey } },
          select: { id: true, kind: true, updatedAt: true, followUpClaimKey: true },
        });
        const attempts = await db.recoveryOutreachAttempt.findMany({
          where: { checkoutRecoveryId: fixture.recoveryId, sequence: 2 },
          orderBy: { id: "asc" }, select: { status: true, initiationKey: true, updatedAt: true },
        });
        const assessmentCount = commandId ? await db.conversationModerationAssessment.count({
          where: { merchantSendCommandId: commandId },
        }) : 0;
        return {
          commandRows: command ? 1 : 0,
          commandKind: command?.kind ?? null,
          commandUpdatedAt: command?.updatedAt.toISOString() ?? null,
          followUpRows: attempts.length,
          followUpState: attempts.map(attempt => ({ status: attempt.status,
            initiationKey: attempt.initiationKey, updatedAt: attempt.updatedAt.toISOString() })),
          assessmentRows: assessmentCount,
          claimMatchesCommand: command ? command.followUpClaimKey === command.id : null,
          textClaimIsNull: command?.kind === "HUMAN_TEXT" ? command.followUpClaimKey === null : null,
        };
      };
      const runProfile = async (profile: string, setup: (index: number) => Promise<MeasurementFixture>,
        invoke: (fixture: MeasurementFixture, instrumented: Pick<PrismaClient, "$transaction">) => Promise<{
          outcome: string; responseRows: number; commandId?: string;
        }>, reuseFixture = false) => {
        const samples: Array<Record<string, unknown>> = [];
        let reusable: MeasurementFixture | undefined;
        if (reuseFixture) reusable = await setup(0);
        for (let execution = 0; execution < 7; execution += 1) {
          const fixture = reusable ?? await setup(execution);
          const before = await stateSnapshot(fixture, fixture.commandId);
          const counters = m07Counters();
          const measuredDatabase = instrumentDatabase(db, counters);
          statements.length = 0;
          const senderLookupsBefore = senderFactoryCalls;
          const senderReadsBefore = senderReaderCalls;
          const startedAt = performance.now();
          let result: { outcome: string; responseRows: number; commandId?: string };
          try {
            result = await invoke(fixture, measuredDatabase);
          } catch (error) {
            const failure = error as { code?: string; status?: number };
            result = { outcome: `error:${failure.code ?? failure.status ?? (error instanceof Error ? error.name : "unknown")}`,
              responseRows: 0 };
          }
          const elapsedMs = performance.now() - startedAt;
          const emitted = statements.slice(0).map(statement => ({
            shape: normalizeSql(statement.query), durationMs: statement.durationMs,
          }));
          const after = await stateSnapshot(fixture, result.commandId ?? fixture.commandId);
          const shapes = [...new Set(emitted.map(statement => statement.shape))];
          const transactionControls = {
            begin: emitted.filter(statement => /^BEGIN\b/i.test(statement.shape)).length,
            isolation: emitted.filter(statement => /^(SET TRANSACTION|SET LOCAL)/i.test(statement.shape)).length,
            commit: emitted.filter(statement => /^COMMIT\b/i.test(statement.shape)).length,
            rollback: emitted.filter(statement => /^ROLLBACK\b/i.test(statement.shape)).length,
          };
          const sample = {
            outcome: result.outcome,
            responseRows: result.responseRows,
            logicalClientCalls: counters.logicalClientCalls,
            clientCallsByDelegate: counters.delegateCalls,
            transactionCalls: counters.transactionCalls,
            transactionElapsedMs: counters.transactionElapsedMs.map(value => Number(value.toFixed(2))),
            retryCount: "not_applicable_no_service_retry_loop",
            operationElapsedMs: Number(elapsedMs.toFixed(2)),
            statementCalls: emitted.length,
            senderFactoryInvocations: senderFactoryCalls - senderLookupsBefore,
            senderReaderInvocations: senderReaderCalls - senderReadsBefore,
            platformConfigurationSqlReads: emitted.filter(statement =>
              /FROM\s+"public"\."PlatformConfiguration"/i.test(statement.shape)).length,
            configurationReadBoundary: sourceRoot
              ? "root_client_inside_admission_transaction" : "supplied_transaction_client",
            transactionControls,
            statementShapes: emitted.map(statement => ({ shapeIndex: shapes.indexOf(statement.shape),
              durationMs: statement.durationMs })),
            distinctStatementShapes: shapes,
            observedRows: {
              commandDelta: after.commandRows - before.commandRows,
              followUpAttemptDelta: after.followUpRows - before.followUpRows,
              assessmentDelta: after.assessmentRows - before.assessmentRows,
              stateUnchanged: JSON.stringify(before) === JSON.stringify(after),
              after,
            },
            externalPortInvocations: "not_applicable_no_provider_port_in_service",
          };
          if (execution >= 2) samples.push(sample);
          if (reusable && execution === 0 && result.commandId) {
            reusable = { ...fixture, commandId: result.commandId } as MeasurementFixture;
          }
          if (profile === "human_text.admission" && execution === 0 && result.commandId) {
            fixture.commandId = result.commandId;
          }
          if (profile === "due_template.admission" && process.env.ARCH055_MEASURE_VERSION === "candidate") {
            assert.equal(result.outcome, "accepted:202");
            assert.equal(after.commandRows - before.commandRows, 1);
            assert.equal(after.followUpRows - before.followUpRows, 1);
            assert.equal(after.claimMatchesCommand, true);
          }
          if (profile === "due_template.admission" && process.env.ARCH055_MEASURE_VERSION === "baseline") {
            assert.equal(result.outcome, "error:template_not_allowed");
            assert.equal(after.commandRows - before.commandRows, 0);
            assert.equal(after.followUpRows - before.followUpRows, 0);
          }
          if (profile === "human_text.admission") {
            assert.equal(result.outcome, "accepted:202");
            assert.equal(after.commandRows - before.commandRows, 1);
            assert.equal(after.followUpRows - before.followUpRows, 0);
            assert.equal(after.textClaimIsNull, true);
          }
          if (profile === "matching_replay" || profile === "prepared_status") {
            assert.equal(JSON.stringify(before), JSON.stringify(after));
          }
          if (profile === "prepared_status") {
            assert.equal(result.outcome, process.env.ARCH055_MEASURE_VERSION === "baseline"
              ? "status:moderation_pending" : "status:moderation_allowed");
          }
          if (reuseFixture && execution === 0 && result.commandId) {
            (reusable as MeasurementFixture & { commandId?: string }).commandId = result.commandId;
          }
          if (execution < 2 && profile === "matching_replay" && result.outcome !== "replay:200") {
            assert.fail(`M07 replay warm-up failed: ${result.outcome}`);
          }
          if (execution < 2 && profile === "prepared_status" && !result.outcome.startsWith("status:")) {
            assert.fail(`M07 status warm-up failed: ${result.outcome}`);
          }
        }
        console.log(`ARCH055-M07-${process.env.ARCH055_MEASURE_VERSION} ${profile} ` +
          JSON.stringify({ warmups: 2, samples }));
      };

      const textFixtures: MeasurementFixture[] = [];
      await runProfile("human_text.admission", async index => {
        const fixture = await createMeasurementFixture("text", index);
        textFixtures[index] = fixture;
        return fixture;
      }, async (fixture, measuredDatabase) => {
        const measuredAdmission = new AdmissionService(measuredDatabase, () => now,
          measuredSender as TransactionConfigurationDatabase & typeof senderFactory);
        const result = await measuredAdmission.admit(principal(first), fixture.conversationId, fixture.input);
        return { outcome: `accepted:${result.code}`, responseRows: result.response ? 1 : 0,
          commandId: result.response.commandId };
      });
      await runProfile("due_template.admission", index => createMeasurementFixture("template", index),
        async (fixture, measuredDatabase) => {
          const measuredAdmission = new AdmissionService(measuredDatabase, () => now,
            measuredSender as TransactionConfigurationDatabase & typeof senderFactory);
          const result = await measuredAdmission.admit(principal(first), fixture.conversationId, fixture.input);
          return { outcome: `accepted:${result.code}`, responseRows: result.response ? 1 : 0,
            commandId: result.response.commandId };
        });
      const replayFixture = textFixtures[0]!;
      const replayCommand = await db.merchantConversationSendCommand.findUniqueOrThrow({
        where: { shopId_idempotencyKey: { shopId: first.shop.id, idempotencyKey: replayFixture.idempotencyKey } },
        select: { id: true },
      });
      replayFixture.commandId = replayCommand.id;
      await runProfile("matching_replay", async () => replayFixture,
        async (fixture, measuredDatabase) => {
          const measuredAdmission = new AdmissionService(measuredDatabase, () => now,
            measuredSender as TransactionConfigurationDatabase & typeof senderFactory);
          const result = await measuredAdmission.admit(principal(first), fixture.conversationId, fixture.input);
          return { outcome: `replay:${result.code}`, responseRows: result.response ? 1 : 0,
            commandId: result.response.commandId };
        }, true);

      const preparedCommand = await db.merchantConversationSendCommand.findUniqueOrThrow({
        where: { id: replayFixture.commandId },
      });
      const measuredPreparedBody = "M07 prepared status body";
      const preparedLeaseToken = id();
      const preparedAt = new Date();
      await db.$executeRaw`UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "state"='CLAIMED',"leaseToken"=${preparedLeaseToken},"leaseExpiresAt"=${new Date(preparedAt.getTime() + 60_000)},
          "dispatchAttemptCount"=1,"updatedAt"=${preparedAt}
        WHERE "id"=${preparedCommand.id} AND "state"='ACCEPTED'`;
      const preparedEvidence = { schemaVersion: 1, outcome: "PASSTHROUGH", reason: "PREPARED",
        bodySha256: sha(measuredPreparedBody) };
      await db.$executeRaw`UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "preparedTextBody"=${measuredPreparedBody},"preparedWrapperEvidence"=${JSON.stringify(preparedEvidence)}::jsonb,
          "preparedAt"=${preparedAt},"updatedAt"=${preparedAt}
        WHERE "id"=${preparedCommand.id} AND "state"='CLAIMED' AND "leaseToken"=${preparedLeaseToken}
          AND "preparedTextBody" IS NULL`;
      const [preparedAssessment] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "whatsapp".arch040_moderation_create_or_reuse(
          ${id()},${first.shop.id},${replayFixture.conversationId},
          'HUMAN_COMMAND'::"whatsapp"."ConversationModerationSubject",NULL,${preparedCommand.id},
          ${sha(measuredPreparedBody)},'TEXT','arch055-m07-model','arch055-m07-policy') AS "id"
      `);
      assert.ok(preparedAssessment?.id);
      const preparedModerationLease = id();
      await db.conversationModerationAssessment.update({ where: { id: preparedAssessment!.id }, data: {
        decision: "CHECKING", attemptCount: 1, leaseToken: preparedModerationLease,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      } });
      const [preparedCompleted] = await db.$queryRaw<Array<{ result: boolean }>>(Prisma.sql`
        SELECT "whatsapp".arch040_moderation_complete(${preparedAssessment!.id},${preparedModerationLease},
          'ALLOW'::"whatsapp"."ConversationModerationDecision",'arch055-m07-model',false,
          '{}'::jsonb,'{}'::jsonb,NULL,'arch055-m07-request',NULL) AS "result"
      `);
      assert.equal(preparedCompleted?.result, true);
      const measuredStatus = new StatusService(db);
      assert.equal((await measuredStatus.read(principal(first), replayFixture.conversationId,
        preparedCommand.id)).moderationStatus,
      process.env.ARCH055_MEASURE_VERSION === "baseline" ? "moderation_pending" : "moderation_allowed");
      await runProfile("prepared_status", async () => replayFixture,
        async (fixture, measuredDatabase) => {
          const measured = new StatusService(measuredDatabase);
          const result = await measured.read(principal(first), fixture.conversationId, preparedCommand.id);
          return { outcome: `status:${result.moderationStatus}`, responseRows: result ? 1 : 0,
            commandId: preparedCommand.id };
        }, true);
      return;
    }
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

    const allowInput = { ...textInput, idempotencyKey: id(), textBody: "Original allow body" };
    const allowAccepted = await admission.admit(principal(first), humanConversation.id, allowInput);
    assert.equal(allowAccepted.code, 202);
    const allowCommand = await db.merchantConversationSendCommand.findUniqueOrThrow({
      where: { id: allowAccepted.response.commandId },
    });
    const allowPreparedBody = "Prepared allow body differs";
    const allowLeaseToken = id();
    const allowLeaseAt = new Date();
    await db.$executeRaw`UPDATE "whatsapp"."MerchantConversationSendCommand"
      SET "state"='CLAIMED',"leaseToken"=${allowLeaseToken},"leaseExpiresAt"=${new Date(allowLeaseAt.getTime() + 60_000)},
        "dispatchAttemptCount"=1,"updatedAt"=${allowLeaseAt}
      WHERE "id"=${allowCommand.id} AND "state"='ACCEPTED'`;
    const allowEvidence = { schemaVersion: 1, outcome: "PASSTHROUGH", reason: "PREPARED", bodySha256: sha(allowPreparedBody) };
    await db.$executeRaw`UPDATE "whatsapp"."MerchantConversationSendCommand"
      SET "preparedTextBody"=${allowPreparedBody},"preparedWrapperEvidence"=${JSON.stringify(allowEvidence)}::jsonb,
        "preparedAt"=${allowLeaseAt},"updatedAt"=${allowLeaseAt}
      WHERE "id"=${allowCommand.id} AND "state"='CLAIMED' AND "leaseToken"=${allowLeaseToken}
        AND "preparedTextBody" IS NULL`;
    await assert.rejects(db.$transaction(tx => tx.$queryRaw(Prisma.sql`
      SELECT "whatsapp".arch040_moderation_create_or_reuse(
        ${id()},${first.shop.id},${humanConversation.id},
        'HUMAN_COMMAND'::"whatsapp"."ConversationModerationSubject",NULL,${allowCommand.id},
        ${sha(allowInput.textBody)},'TEXT','arch055-test-model','arch055-prepared-v1')
    `)));
    assert.equal((await status.read(principal(first), humanConversation.id, allowCommand.id)).moderationStatus,
      "moderation_pending");
    const [allowAssessment] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "whatsapp".arch040_moderation_create_or_reuse(
        ${id()},${first.shop.id},${humanConversation.id},
        'HUMAN_COMMAND'::"whatsapp"."ConversationModerationSubject",NULL,${allowCommand.id},
        ${sha(allowPreparedBody)},'TEXT','arch055-test-model','arch055-prepared-v1') AS "id"
    `);
    assert.ok(allowAssessment?.id);
    const allowModerationLease = id();
    await db.conversationModerationAssessment.update({ where: { id: allowAssessment!.id }, data: {
      decision: "CHECKING", attemptCount: 1, leaseToken: allowModerationLease,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    } });
    const [allowCompleted] = await db.$queryRaw<Array<{ result: boolean }>>(Prisma.sql`
      SELECT "whatsapp".arch040_moderation_complete(${allowAssessment!.id},${allowModerationLease},
        'ALLOW'::"whatsapp"."ConversationModerationDecision",'arch055-test-model',false,
        '{}'::jsonb,'{}'::jsonb,NULL,'arch055-allow-request',NULL) AS "result"
    `);
    assert.equal(allowCompleted?.result, true);
    assert.equal((await status.read(principal(first), humanConversation.id, allowCommand.id)).moderationStatus,
      "moderation_allowed");

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
    await db.platformConfiguration.deleteMany({ where: { environment: "test", key: "messaging.sender" } });
    await db.$disconnect();
  }
});