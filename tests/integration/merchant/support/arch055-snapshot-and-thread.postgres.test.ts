import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { MerchantSupportCommandService, supportSourceKey } from "../../../../src/merchant/support/commands.service.js";
import { MerchantSupportReadService } from "../../../../src/merchant/support/read.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const waitFor = async (db: PrismaClient, sql: Prisma.Sql, expected: number) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    const rows = await db.$queryRaw<Array<{ count: number }>>(sql);
    if (rows[0]?.count === expected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("ARCH-055 test barrier timed out");
};

test("ARCH-055-API-008 M16: coherent Support snapshot and atomic thread composition", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const queryEvents: Array<{ query: string; duration: number }> = [];
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } },
    transactionOptions: { maxWait: 30_000, timeout: 30_000 }, log: [{ emit: "event", level: "query" }] });
  db.$on("query", event => { queryEvents.push({ query: event.query, duration: event.duration }); });
  const shopIds: string[] = [];
  const id = randomUUID();
  const warnings: string[] = [];
  let dispatchCalls = 0;
  const logger = { info() {}, error() {}, warn(name: string) { warnings.push(name); } } as never;
  const commands = new MerchantSupportCommandService(db, { async enqueue() { dispatchCalls++; } }, logger);
  const read = new MerchantSupportReadService(db);
  try {
    const shops = await Promise.all(["fr-FR", "en-GB"].map(defaultLanguageTag => db.shop.create({
      data: { domain: `https://arch055-${id}-${defaultLanguageTag}.invalid`, platform: "WOOCOMMERCE", defaultLanguageTag },
    })));
    shopIds.push(...shops.map(shop => shop.id));
    const principals = await Promise.all(shops.map(async shop => {
      const installation = await db.wooCommerceInstallation.create({ data: {
        shopId: shop.id, canonicalSiteUrl: shop.domain, credentialDigest: Buffer.alloc(32),
      } });
      return { shopId: shop.id, installationId: installation.id,
        credentialVersion: installation.credentialVersion, canonicalSiteUrl: shop.domain };
    }));
    const [thread] = await Promise.all([db.merchantSupportThread.create({ data: { shopId: shops[0]!.id } })]);
    const createdAt = new Date("2026-11-02T12:00:00.000Z");
    const messages = Array.from({ length: 105 }, (_, index) => ({
      id: randomUUID(), threadId: thread!.id, kind: index % 4 === 0 ? "SYSTEM" as const : "ADMINISTRATIVE" as const,
      state: "AVAILABLE" as const, originalBody: `Support item ${index}`, sourceLanguageTag: "en-GB",
      displayLanguageTag: "fr-FR",
      ...(index % 4 === 0 ? { systemCode: "WHATSAPP_CONSENT_REQUIRED", systemVersion: "1" } : {}),
      availableAt: createdAt,
      createdAt: new Date(createdAt.getTime() + index), readAt: index % 5 === 0 ? createdAt : null,
    }));
    await db.merchantSupportMessage.createMany({ data: messages });
    await db.merchantMessageTranslation.createMany({ data: messages.map(message => ({
      messageId: message.id, direction: "ADMIN_TO_MERCHANT", sourceLanguageTag: "en-GB",
      targetLanguageTag: "fr-FR", status: "AVAILABLE", translatedBody: `Réponse ${message.originalBody}`,
    })) });
    await db.merchantSupportThread.create({ data: { shopId: shops[1]!.id } });

    const evidence: Array<Record<string, unknown>> = [];
    const sqlShapes: Record<string, string[]> = {};
    const runProfile = async (profile: string, prepare: (index: number) => Promise<void>,
      operation: (index: number) => Promise<{ rowCount: number; affectedRows: number; noOp: boolean;
        verify?: () => Promise<Record<string, unknown>> }>) => {
      for (let index = 0; index < 7; index++) {
        await prepare(index);
        const queryStart = queryEvents.length;
        const dispatchStart = dispatchCalls;
        const startedAt = performance.now();
        const result = await operation(index);
        const elapsedMs = Number((performance.now() - startedAt).toFixed(3));
        const emitted = queryEvents.slice(queryStart);
        const statements = emitted.map(event => event.query.trim().replace(/\s+/g, " "));
        const shapeCounts: Record<string, number> = {};
        for (const statement of statements) shapeCounts[statement] = (shapeCounts[statement] ?? 0) + 1;
        const profileShapes = sqlShapes[profile] ?? (sqlShapes[profile] = []);
        for (const statement of Object.keys(shapeCounts)) if (!profileShapes.includes(statement)) profileShapes.push(statement);
        const verified = result.verify ? await result.verify() : {};
        const recorded = { profile, sample: index < 2 ? `warmup-${index + 1}` : index - 1,
          serviceElapsedMs: elapsedMs, clientCalls: emitted.length,
          transactionStatements: statements.filter(sql => /^(?:BEGIN|START TRANSACTION|COMMIT|ROLLBACK)\b/i.test(sql)),
          rowCount: result.rowCount, affectedRows: result.affectedRows, noOp: result.noOp,
          queryDurationsMs: emitted.map(event => event.duration), dispatchCalls: dispatchCalls - dispatchStart,
          verified, statementCounts: shapeCounts };
        if (index >= 2) evidence.push(recorded);
      }
    };
    const restoreUnreadFlags = async () => {
      await db.merchantSupportMessage.updateMany({
        where: { id: { in: messages.filter((_message, index) => index % 5 === 0).map(message => message.id) } },
        data: { readAt: createdAt },
      });
      await db.merchantSupportMessage.updateMany({
        where: { id: { in: messages.filter((_message, index) => index % 5 !== 0).map(message => message.id) } },
        data: { readAt: null },
      });
    };
    const resetMessage = async (shopId: string, body: string) => {
      await db.merchantSupportMessage.deleteMany({ where: { thread: { shopId }, originalBody: body } });
      await db.merchantSupportThread.update({ where: { shopId }, data: { lastMessageAt: null,
        lastMerchantMessageAt: null, needsAdminResponse: false, merchantMessageVersion: 0 } });
    };
    await runProfile("page-first-50", restoreUnreadFlags, async () => {
      const result = await read.read(principals[0]!, { page: 1, pageSize: 50 });
      return { rowCount: result.items.length, affectedRows: 0, noOp: false };
    });
    await runProfile("page-empty", restoreUnreadFlags, async () => {
      const result = await read.read(principals[0]!, { page: 4, pageSize: 50 });
      return { rowCount: result.items.length, affectedRows: 0, noOp: false };
    });
    for (const [profile, shopIndex, body] of [
      ["compose-translated", 0, "M16 translated compose"], ["compose-no-translation", 1, "M16 English compose"],
    ] as const) {
      await runProfile(profile, async () => resetMessage(shops[shopIndex]!.id, body), async index => {
        const result = await commands.compose(principals[shopIndex]!, { body, actionId: `arch055-${profile}-${index}` });
        return { rowCount: 1, affectedRows: result.created ? 1 : 0, noOp: !result.created,
          verify: async () => ({ persistedMessageRows: await db.merchantSupportMessage.count({
            where: { originalBody: body },
          }), persistedThreadVersion: (await db.merchantSupportThread.findUniqueOrThrow({
            where: { shopId: shops[shopIndex]!.id }, select: { merchantMessageVersion: true },
          })).merchantMessageVersion }) };
      });
      await resetMessage(shops[shopIndex]!.id, body);
    }
    await runProfile("compose-replay", async index => {
      await db.merchantSupportMessage.deleteMany({ where: { threadId: thread!.id, originalBody: "M16 replay" } });
      await db.merchantSupportMessage.deleteMany({ where: { sourceKey: supportSourceKey(shops[0]!.id, `arch055-replay-${index}`) } });
      const replayMessageId = randomUUID();
      await db.merchantSupportMessage.create({ data: { id: replayMessageId, threadId: thread!.id,
        kind: "MERCHANT", state: "AVAILABLE", originalBody: "M16 replay", sourceLanguageTag: "fr-FR",
        displayLanguageTag: "fr-FR", sourceKey: supportSourceKey(shops[0]!.id, `arch055-replay-${index}`),
        availableAt: createdAt } });
      await db.merchantMessageTranslation.create({ data: { messageId: replayMessageId,
        direction: "MERCHANT_TO_ADMIN", sourceLanguageTag: "fr-FR", targetLanguageTag: "en-GB", status: "PENDING" } });
    }, async index => {
      const result = await commands.compose(principals[0]!, { body: "M16 replay", actionId: `arch055-replay-${index}` });
      return { rowCount: 1, affectedRows: result.created ? 1 : 0, noOp: !result.created,
        verify: async () => ({ persistedMessageRows: await db.merchantSupportMessage.count({
          where: { sourceKey: supportSourceKey(shops[0]!.id, `arch055-replay-${index}`) },
        }), persistedThreadVersion: (await db.merchantSupportThread.findUniqueOrThrow({
          where: { shopId: shops[0]!.id }, select: { merchantMessageVersion: true },
        })).merchantMessageVersion }) };
    });
    await db.merchantSupportMessage.deleteMany({ where: { threadId: thread!.id, originalBody: "M16 replay" } });
    console.log(`ARCH055_M16_EVIDENCE ${JSON.stringify({ version: process.env.ARCH055_BASELINE_PROFILE ? "baseline" : "candidate", samples: evidence, sqlShapes })}`);

    const baselineQueryIndex = queryEvents.length;
    const first = await read.read(principals[0]!, { page: 1, pageSize: 50 });
    const firstDataQueries = queryEvents.slice(baselineQueryIndex).map(event => event.query)
      .filter(query => query.includes('"support"."MerchantSupportMessage"'));
    const baselineMode = process.env.ARCH055_BASELINE_PROFILE === "1";
    assert.equal(firstDataQueries.length, baselineMode ? 2 : 1, "Support page and aggregate statement count changed");
    assert.equal(first.items.length, 50); assert.equal(first.total, 105); assert.equal(first.unread, 84);
    assert.equal(first.items[0]?.displayBody, "Réponse Support item 0");
    assert.equal((await read.read(principals[0]!, { page: 3, pageSize: 50 })).items.length, 5);
    const empty = await read.read(principals[0]!, { page: 4, pageSize: 50 });
    assert.equal(empty.items.length, 0); assert.equal(empty.total, 105); assert.equal(empty.unread, 84);
    if (!baselineMode) {
      assert.match(firstDataQueries[0]!, /LEFT JOIN "support"\."MerchantMessageTranslation"/);
      assert.doesNotMatch(firstDataQueries[0]!, /LATERAL|ORDER BY "createdAt" DESC/);
    }

    // Commit a mark after the data statement returns but before the service maps its result.
    // This is the exact former page/count boundary; the single-statement version has no second read.
    const raceTarget = messages[1]!;
    let interleaved = false;
    const interleavedDatabase = {
      $transaction: <T>(operation: (tx: never) => Promise<T>, options: unknown) => db.$transaction(tx => {
        const wrapped = new Proxy(tx, { get(target, property, receiver) {
          if (property === "$queryRaw") return async (...args: unknown[]) => {
            const result = await target.$queryRaw(args[0] as Prisma.Sql) as unknown;
            const sql = (args[0] as Prisma.Sql | undefined)?.sql ?? "";
            if (!interleaved && sql.includes('"support"."MerchantSupportMessage"')) {
              interleaved = true;
              await db.$executeRaw(Prisma.sql`UPDATE "support"."MerchantSupportMessage"
                SET "readAt"=NOW(),"updatedAt"=NOW() WHERE "id"=${raceTarget.id} AND "readAt" IS NULL`);
            }
            return result;
          };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        return operation(wrapped as never);
      }, options as never),
    };
    const interleavedRead = new MerchantSupportReadService(interleavedDatabase as never);
    const snapshot = await interleavedRead.read(principals[0]!, { page: 1, pageSize: 50 });
    assert.equal(interleaved, true, "the committed mark must run between data read and response mapping");
    const snapshotTarget = snapshot.items.find(item => item.id === raceTarget.id)!;
    if (baselineMode) {
      assert.equal(snapshotTarget.readAt, null);
      assert.equal(snapshot.unread, 83, "baseline should expose the former page/count boundary");
    } else {
      assert.equal(snapshotTarget.readAt === null, snapshot.unread === 84,
        "page readAt and unread aggregate must describe the same statement snapshot");
      assert.equal(snapshotTarget.readAt, null);
    }

    const pending = await db.merchantSupportMessage.create({ data: { threadId: thread!.id,
      kind: "ADMINISTRATIVE", state: "AVAILABLE", originalBody: "Must stay hidden while pending",
      sourceLanguageTag: "en-GB", displayLanguageTag: "fr-FR", availableAt: createdAt } });
    await db.merchantMessageTranslation.create({ data: { messageId: pending.id, direction: "ADMIN_TO_MERCHANT",
      sourceLanguageTag: "en-GB", targetLanguageTag: "fr-FR", status: "PENDING" } });
    const foreignRecovery = await db.checkoutRecovery.create({ data: {
      shopId: shops[1]!.id, checkoutToken: `arch055-${id}`, lastExternalActivityAt: createdAt,
    } });
    const foreignNotice = await db.merchantSupportMessage.create({ data: { threadId: thread!.id,
      kind: "SYSTEM", state: "AVAILABLE", originalBody: "Foreign recovery link", sourceLanguageTag: "en-GB",
      systemCode: "RECOVERY_INITIAL_OUTREACH_SENT", systemVersion: "1", checkoutRecoveryId: foreignRecovery.id,
      availableAt: createdAt } });
    const projected = await read.read(principals[0]!, { page: 3, pageSize: 50 });
    assert.equal(projected.items.length, 7);
    assert.equal(projected.items.find(item => item.id === pending.id)?.originalBody, "");
    assert.equal(projected.items.find(item => item.id === pending.id)?.displayBody, null);
    assert.equal(projected.items.find(item => item.id === foreignNotice.id)?.checkoutRecoveryId, null);

    const composeStart = queryEvents.length;
    const translatedCompose = await commands.compose(principals[0]!, { body: "Bonjour", actionId: "arch055-translated" });
    assert.equal(translatedCompose.created, true); assert.ok(translatedCompose.response.translationId);
    const composeThreadWrites = queryEvents.slice(composeStart).map(event => event.query)
      .filter(query => query.includes('"support"."MerchantSupportThread"') && /^\s*(?:INSERT|UPDATE)\b/i.test(query));
    assert.equal(composeThreadWrites.length, baselineMode ? 2 : 1, "compose thread bookkeeping statements changed");
    const noTranslationCompose = await commands.compose(principals[1]!, { body: "Hello", actionId: "arch055-english" });
    assert.equal(noTranslationCompose.created, true); assert.equal(noTranslationCompose.response.translationId, null);
    const composeThread = await db.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shops[0]!.id } });
    assert.equal(composeThread.merchantMessageVersion, 1);
    const replayStart = queryEvents.length;
    const replay = await commands.compose(principals[0]!, { body: "Bonjour", actionId: "arch055-translated" });
    assert.equal(replay.created, false);
    const replayWrites = queryEvents.slice(replayStart).map(event => event.query)
      .filter(query => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(query));
    assert.equal(replayWrites.length, 0, `matching replay performs no writes: ${JSON.stringify(replayWrites)}`);
    assert.equal((await db.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shops[0]!.id } })).merchantMessageVersion, 1);

    // Exercise the API UPSERT against a concurrent administrative thread write.
    let releaseAdminReply!: () => void;
    let adminReplyLocked!: () => void;
    const adminLockReady = new Promise<void>(resolve => { adminReplyLocked = resolve; });
    const adminReplyRelease = new Promise<void>(resolve => { releaseAdminReply = resolve; });
    const adminReply = db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "support"."MerchantSupportThread" WHERE "id"=${thread!.id} FOR UPDATE`);
      await tx.$executeRaw(Prisma.sql`UPDATE "support"."MerchantSupportThread" SET
        "lastMessageAt"=${createdAt},"lastAdministrativeMessageAt"=${createdAt},
        "merchantMessageVersion"="merchantMessageVersion"+1,"needsAdminResponse"=false
        WHERE "id"=${thread!.id}`);
      await tx.merchantSupportMessage.create({ data: { threadId: thread!.id,
        kind: "ADMINISTRATIVE", state: "AVAILABLE", originalBody: "Concurrent admin reply",
        sourceLanguageTag: "en-GB", availableAt: createdAt } });
      adminReplyLocked(); await adminReplyRelease;
    });
    await adminLockReady;
    const racingCompose = commands.compose(principals[0]!, { body: "Concurrent merchant reply", actionId: "arch055-admin-race" });
    await waitFor(db, Prisma.sql`SELECT COUNT(*)::int AS count FROM pg_stat_activity
      WHERE wait_event_type='Lock' AND query LIKE '%INSERT INTO "support"."MerchantSupportThread"%'`, 1);
    releaseAdminReply(); await adminReply;
    assert.equal((await racingCompose).created, true);
    const afterAdminRace = await db.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shops[0]!.id } });
    assert.equal(afterAdminRace.merchantMessageVersion, 3);
    assert.equal(afterAdminRace.needsAdminResponse, true);

    // A forced message insert failure after the upsert must roll all thread bookkeeping back.
    const triggerSuffix = id.replaceAll("-", "");
    const functionName = `arch055_fail_message_${triggerSuffix}`;
    const triggerName = `arch055_fail_message_trigger_${triggerSuffix}`;
    await db.$executeRaw(Prisma.sql`CREATE FUNCTION "support"."${Prisma.raw(functionName)}"() RETURNS trigger
      LANGUAGE plpgsql AS $function$ BEGIN RAISE EXCEPTION 'arch055 injected message failure'; END; $function$`);
    await db.$executeRaw(Prisma.sql`CREATE TRIGGER "${Prisma.raw(triggerName)}" BEFORE INSERT ON "support"."MerchantSupportMessage"
      FOR EACH ROW EXECUTE FUNCTION "support"."${Prisma.raw(functionName)}"()`);
    try {
      await assert.rejects(commands.compose(principals[0]!, { body: "Rollback", actionId: "arch055-rollback" }));
      assert.equal((await db.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shops[0]!.id } })).merchantMessageVersion, 3);
      assert.equal(await db.merchantSupportMessage.count({ where: { sourceKey: { not: null }, originalBody: "Rollback" } }), 0);
    } finally {
      await db.$executeRaw(Prisma.sql`DROP TRIGGER IF EXISTS "${Prisma.raw(triggerName)}" ON "support"."MerchantSupportMessage"`);
      await db.$executeRaw(Prisma.sql`DROP FUNCTION IF EXISTS "support"."${Prisma.raw(functionName)}"()`);
    }

    // Hold a row lock until both conditional mark updates are waiting, then release the winner race.
    const unreadTarget = messages[2]!;
    let releaseMarks!: () => void;
    let marksLocked!: () => void;
    const marksLockReady = new Promise<void>(resolve => { marksLocked = resolve; });
    const marksRelease = new Promise<void>(resolve => { releaseMarks = resolve; });
    const rowLocker = db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "support"."MerchantSupportMessage" WHERE "id"=${unreadTarget.id} FOR UPDATE`);
      marksLocked(); await marksRelease;
    });
    await marksLockReady;
    const markOne = commands.markRead(principals[0]!, unreadTarget.id);
    const markTwo = commands.markRead(principals[0]!, unreadTarget.id);
    await waitFor(db, Prisma.sql`SELECT COUNT(*)::int AS count FROM pg_stat_activity
      WHERE wait_event_type='Lock' AND query LIKE '%UPDATE "support"."MerchantSupportMessage" m SET "readAt"%'`, 1);
    releaseMarks(); await rowLocker;
    const [winnerOne, winnerTwo] = await Promise.all([markOne, markTwo]);
    assert.equal(winnerOne.readAt, winnerTwo.readAt);
    assert.equal((await db.merchantSupportMessage.findUniqueOrThrow({ where: { id: unreadTarget.id } })).readAt?.toISOString(), winnerOne.readAt);
    const markReplay = await commands.markRead(principals[0]!, unreadTarget.id);
    assert.equal(markReplay.readAt, winnerOne.readAt);
    assert.deepEqual(warnings, []);
  } finally {
    if (shopIds.length) await db.shop.deleteMany({ where: { id: { in: shopIds } } });
    await db.$disconnect();
  }
});
