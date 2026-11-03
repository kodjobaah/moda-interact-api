import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { MerchantRecoveryDetailService } from "../../../../../src/merchant/recoveries/detail/read.service.js";
import { MerchantRecoveryListService } from "../../../../../src/merchant/recoveries/list.service.js";
import { encodeDetailCursor } from "../../../../../src/merchant/recoveries/detail/cursor.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

interface M06Counters {
  logicalClientCalls: number;
  transactionCalls: number;
  transactionElapsedMs: number[];
  delegateCalls: Record<string, number>;
}

function instrumentM06Client<T extends object>(client: T, counters: M06Counters): T {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "$transaction" && typeof value === "function") {
        return (...args: unknown[]) => {
          const callback = args[0];
          if (typeof callback !== "function") {
            counters.logicalClientCalls += 1;
            counters.delegateCalls.$transaction = (counters.delegateCalls.$transaction ?? 0) + 1;
            return Reflect.apply(value, target, args);
          }
          counters.transactionCalls += 1;
          const startedAt = performance.now();
          return Reflect.apply(value, target, [
            (tx: Prisma.TransactionClient) => callback(instrumentM06Client(tx, counters)), args[1],
          ]).finally(() => counters.transactionElapsedMs.push(performance.now() - startedAt));
        };
      }
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

function normalizeSql(query: string): string {
  return query.replace(/\$\d+/g, "?").replace(/\s+/g, " ").trim();
}

test("ARCH-055 bounded recovery message and related pagination", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  const statements: Array<{ query: string; duration: number }> = [];
  const db = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [{ emit: "event", level: "query" }],
  });
  db.$on("query", event => statements.push({ query: event.query, duration: event.duration }));
  const id = () => randomUUID();
  const now = new Date("2026-11-02T12:00:00.000Z");
  const shopIds: string[] = [];
  try {
    const shop = await db.shop.create({ data: {
      id: "arch055_m06_shop", domain: "https://arch055-m06.invalid", platform: "WOOCOMMERCE", status: "ACTIVE",
    } });
    shopIds.push(shop.id);
    const installation = await db.wooCommerceInstallation.create({ data: {
      id: "arch055_m06_installation", shopId: shop.id, canonicalSiteUrl: shop.domain,
      credentialDigest: Uint8Array.from(createHash("sha256").update(id()).digest()),
    } });
    const customer = await db.customer.create({ data: { id: "arch055_m06_customer", shopId: shop.id } });
    const principal = { shopId: shop.id, canonicalSiteUrl: shop.domain,
      installationId: installation.id, credentialVersion: installation.credentialVersion };
    const recoveries = [];
    for (let index = 0; index < 12; index += 1) {
      recoveries.push(await db.checkoutRecovery.create({ data: {
        id: `arch055_m06_recovery_${String(index).padStart(2, "0")}`,
        shopId: shop.id, customerId: customer.id, checkoutToken: `arch055-${index}`,
        detectedAt: now, lastExternalActivityAt: now,
      } }));
    }
    const current = recoveries[0]!;
    const conversation = await db.conversation.create({ data: {
      id: "arch055_m06_conversation", checkoutRecoveryId: current.id, type: "RECOVERY",
    } });
    for (let index = 0; index < 105; index += 1) {
      await db.conversationMessage.create({ data: {
        id: `arch055_m06_message_${String(index).padStart(3, "0")}`,
        conversationId: conversation.id, direction: index % 2 ? "INBOUND" : "OUTBOUND",
        senderType: index % 2 ? "CUSTOMER" : "AUTOMATION", content: `message-${index}`,
        createdAt: new Date(now.getTime() + Math.floor(index / 3) * 1000),
      } });
    }

    const expectedMessages = await db.conversationMessage.findMany({
      where: { conversationId: conversation.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const expectedRelated = await db.checkoutRecovery.findMany({
      where: { shopId: shop.id, customerId: customer.id, id: { not: current.id } },
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }], select: { id: true },
    });
    const sourceRoot = process.env.ARCH055_SOURCE_ROOT;
    const detailModule = sourceRoot
      ? await import(pathToFileURL(resolve(sourceRoot, "src/merchant/recoveries/detail/read.service.js")).href)
      : { MerchantRecoveryDetailService };
    const listModule = sourceRoot
      ? await import(pathToFileURL(resolve(sourceRoot, "src/merchant/recoveries/list.service.js")).href)
      : { MerchantRecoveryListService };
    const DetailService = detailModule.MerchantRecoveryDetailService as typeof MerchantRecoveryDetailService;
    const ListService = listModule.MerchantRecoveryListService as typeof MerchantRecoveryListService;
    const read = new DetailService(db);
    const navFirst = await read.messages(principal, current.id, new URLSearchParams());
    const navNext = await read.messages(principal, current.id,
      new URLSearchParams({ cursor: navFirst!.nextCursor! }));
    const relatedNavFirst = await read.related(principal, current.id, new URLSearchParams());
    const relatedNavNext = await read.related(principal, current.id,
      new URLSearchParams({ cursor: relatedNavFirst!.nextCursor! }));
    const profiles: Array<{ name: string; run: (client: PrismaClient) => Promise<{
      rows: number; ids: string[]; previousCursor: string | null; nextCursor: string | null; total?: number;
    }> }> = [
      { name: "messages.first", run: async client => {
        const page = await new DetailService(client).messages(principal, current.id, new URLSearchParams());
        return { rows: page!.items.length, ids: page!.items.map(item => item.id),
          previousCursor: page!.previousCursor, nextCursor: page!.nextCursor };
      } },
      { name: "messages.latest", run: async client => {
        const page = await new DetailService(client).messages(principal, current.id,
          new URLSearchParams({ window: "latest" }));
        return { rows: page!.items.length, ids: page!.items.map(item => item.id),
          previousCursor: page!.previousCursor, nextCursor: page!.nextCursor };
      } },
      { name: "messages.next", run: async client => {
        const page = await new DetailService(client).messages(principal, current.id,
          new URLSearchParams({ cursor: navFirst!.nextCursor! }));
        return { rows: page!.items.length, ids: page!.items.map(item => item.id),
          previousCursor: page!.previousCursor, nextCursor: page!.nextCursor };
      } },
      { name: "messages.previous", run: async client => {
        const page = await new DetailService(client).messages(principal, current.id,
          new URLSearchParams({ cursor: navNext!.previousCursor! }));
        return { rows: page!.items.length, ids: page!.items.map(item => item.id),
          previousCursor: page!.previousCursor, nextCursor: page!.nextCursor };
      } },
      { name: "related.first", run: async client => {
        const page = await new DetailService(client).related(principal, current.id, new URLSearchParams());
        return { rows: page!.items.length, ids: page!.items.map(item => item.id),
          previousCursor: page!.previousCursor, nextCursor: page!.nextCursor };
      } },
      { name: "related.next", run: async client => {
        const page = await new DetailService(client).related(principal, current.id,
          new URLSearchParams({ cursor: relatedNavFirst!.nextCursor! }));
        return { rows: page!.items.length, ids: page!.items.map(item => item.id),
          previousCursor: page!.previousCursor, nextCursor: page!.nextCursor };
      } },
      { name: "related.previous", run: async client => {
        const page = await new DetailService(client).related(principal, current.id,
          new URLSearchParams({ cursor: relatedNavNext!.previousCursor! }));
        return { rows: page!.items.length, ids: page!.items.map(item => item.id),
          previousCursor: page!.previousCursor, nextCursor: page!.nextCursor };
      } },
      { name: "list.zero", run: async client => {
        const result = await new ListService(client, () => now).read(
          principal, new URLSearchParams({ from: "2026-10-01", to: "2026-10-02" }));
        return { rows: result.items.length, ids: result.items.map(item => item.id),
          previousCursor: null, nextCursor: null, total: result.total };
      } },
    ];
    if (process.env.ARCH055_MEASURE_VERSION) {
      const measurements = [];
      for (const profile of profiles) {
        const samples: Array<Record<string, unknown>> = [];
        for (let execution = 0; execution < 7; execution += 1) {
          const beforeState = {
            messageIds: (await db.conversationMessage.findMany({ where: { conversationId: conversation.id },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, createdAt: true } }))
              .map(row => [row.id, row.createdAt.toISOString()]),
            recoveryIds: (await db.checkoutRecovery.findMany({ where: { shopId: shop.id, customerId: customer.id },
              orderBy: [{ detectedAt: "desc" }, { id: "desc" }], select: { id: true, detectedAt: true } }))
              .map(row => [row.id, row.detectedAt.toISOString()]),
          };
          const counters: M06Counters = { logicalClientCalls: 0, transactionCalls: 0,
            transactionElapsedMs: [], delegateCalls: {} };
          const measuredClient = instrumentM06Client(db, counters);
          statements.length = 0;
          const startedAt = performance.now();
          const result = await profile.run(measuredClient);
          const elapsedMs = performance.now() - startedAt;
          const emittedSql = statements.map(statement => ({ shape: normalizeSql(statement.query),
            durationMs: statement.duration }));
          const afterState = {
            messageIds: (await db.conversationMessage.findMany({ where: { conversationId: conversation.id },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, createdAt: true } }))
              .map(row => [row.id, row.createdAt.toISOString()]),
            recoveryIds: (await db.checkoutRecovery.findMany({ where: { shopId: shop.id, customerId: customer.id },
              orderBy: [{ detectedAt: "desc" }, { id: "desc" }], select: { id: true, detectedAt: true } }))
              .map(row => [row.id, row.detectedAt.toISOString()]),
          };
          const stableState = JSON.stringify(beforeState) === JSON.stringify(afterState);
          assert.equal(stableState, true, `${profile.name} changed persisted fixture state`);
          const shapes = [...new Set(emittedSql.map(statement => statement.shape))];
          const sample = {
            execution: execution + 1,
            elapsedMs: Number(elapsedMs.toFixed(2)),
            returnedRows: result.rows,
            returnedIds: result.ids,
            cursors: { previous: result.previousCursor, next: result.nextCursor },
            total: result.total ?? "not_applicable_for_history_page",
            logicalClientCalls: counters.logicalClientCalls,
            clientCallsByDelegate: counters.delegateCalls,
            sqlCalls: emittedSql.length,
            sqlStatements: emittedSql.map(statement => ({ shapeIndex: shapes.indexOf(statement.shape),
              durationMs: statement.durationMs })),
            distinctSqlShapes: shapes,
            transactionControls: {
              begin: emittedSql.filter(statement => /^BEGIN\b/i.test(statement.shape)).length,
              isolation: emittedSql.filter(statement => /^(SET TRANSACTION|SET LOCAL)/i.test(statement.shape)).length,
              commit: emittedSql.filter(statement => /^COMMIT\b/i.test(statement.shape)).length,
              rollback: emittedSql.filter(statement => /^ROLLBACK\b/i.test(statement.shape)).length,
            },
            transactionCalls: counters.transactionCalls,
            transactionElapsedMs: counters.transactionElapsedMs.map(value => Number(value.toFixed(2))),
            persistedStateUnchanged: stableState,
            affectedRows: stableState ? 0 : "unexpected_state_change",
            retries: "not_applicable_read_service_has_no_retry_loop",
            externalPortInvocations: "not_applicable_database_read_services_have_no_external_ports",
          };
          if (execution >= 2) samples.push(sample);
        }
        const elapsed = samples.map(sample => sample.elapsedMs as number).sort((a, b) => a - b);
        measurements.push({ profile: profile.name, warmups: 2, samples,
          minMs: elapsed[0], medianMs: elapsed[2], maxMs: elapsed[4] });
      }
      for (const measurement of measurements) {
        console.log(`ARCH055-M06-${process.env.ARCH055_MEASURE_VERSION} ${measurement.profile} ` +
          JSON.stringify(measurement));
      }
    }
    statements.length = 0;
    const first = await read.messages(principal, current.id, new URLSearchParams());
    assert.deepEqual(first?.items.map(item => item.id), expectedMessages.slice(0, 50).map(item => item.id));
    assert.equal(first?.previousCursor, null);
    assert.ok(first?.nextCursor);
    const firstSql = statements.splice(0).map(item => item.query);
    if (process.env.ARCH055_MEASURE_VERSION !== "baseline") {
      assert.equal(firstSql.some(query => /COUNT\s*\(/i.test(query) && query.includes('"ConversationMessage"')), false);
    }

    const latest = await read.messages(principal, current.id, new URLSearchParams({ window: "latest" }));
    assert.deepEqual(latest?.items.map(item => item.id), expectedMessages.slice(-50).map(item => item.id));
    assert.ok(latest?.previousCursor);
    assert.equal(latest?.nextCursor, null);
    const next = await read.messages(principal, current.id, new URLSearchParams({ cursor: first!.nextCursor! }));
    assert.deepEqual(next?.items.map(item => item.id), expectedMessages.slice(50, 100).map(item => item.id));
    assert.ok(next?.previousCursor);
    assert.ok(next?.nextCursor);
    const previous = await read.messages(principal, current.id, new URLSearchParams({ cursor: next!.previousCursor! }));
    assert.deepEqual(previous?.items.map(item => item.id), expectedMessages.slice(0, 50).map(item => item.id));

    const relatedFirst = await read.related(principal, current.id, new URLSearchParams());
    assert.deepEqual(relatedFirst?.items.map(item => item.id), expectedRelated.slice(0, 5).map(item => item.id));
    assert.equal(relatedFirst?.previousCursor, null);
    assert.ok(relatedFirst?.nextCursor);
    const relatedNext = await read.related(principal, current.id,
      new URLSearchParams({ cursor: relatedFirst!.nextCursor! }));
    assert.deepEqual(relatedNext?.items.map(item => item.id), expectedRelated.slice(5, 10).map(item => item.id));
    assert.ok(relatedNext?.previousCursor);
    assert.ok(relatedNext?.nextCursor);
    const relatedLast = await read.related(principal, current.id,
      new URLSearchParams({ cursor: relatedNext!.nextCursor! }));
    assert.deepEqual(relatedLast?.items.map(item => item.id), expectedRelated.slice(10).map(item => item.id));
    assert.ok(relatedLast?.previousCursor);
    assert.equal(relatedLast?.nextCursor, null);
    const relatedPrevious = await read.related(principal, current.id,
      new URLSearchParams({ cursor: relatedLast!.previousCursor! }));
    assert.deepEqual(relatedPrevious?.items.map(item => item.id), expectedRelated.slice(5, 10).map(item => item.id));

    const foreignCustomer = await db.customer.create({ data: {
      id: "arch055_m06_foreign_customer", shopId: shop.id,
    } });
    const foreignRecovery = await db.checkoutRecovery.create({ data: {
      id: "zzzz_arch055_m06_foreign_recovery", shopId: shop.id, customerId: foreignCustomer.id,
      checkoutToken: "arch055-foreign", detectedAt: now, lastExternalActivityAt: now,
    } });
    const foreignConversation = await db.conversation.create({ data: {
      id: "arch055_m06_foreign_conversation", checkoutRecoveryId: foreignRecovery.id, type: "RECOVERY",
    } });
    const foreignMessage = await db.conversationMessage.create({ data: {
      id: "arch055_m06_foreign_message", conversationId: foreignConversation.id,
      direction: "INBOUND", senderType: "CUSTOMER", content: "foreign",
      createdAt: new Date(now.getTime() - 24 * 60 * 60_000),
    } });
    const foreignMessageCursor = encodeDetailCursor(shop.id, current.id, "messages", "next", {
      at: foreignMessage.createdAt, id: foreignMessage.id,
    });
    const afterForeignMessage = await read.messages(principal, current.id,
      new URLSearchParams({ cursor: foreignMessageCursor }));
    assert.deepEqual(afterForeignMessage?.items.map(item => item.id), expectedMessages.slice(0, 50).map(item => item.id));
    assert.equal(afterForeignMessage?.items.some(item => item.id === foreignMessage.id), false);

    const foreignRecoveryCursor = encodeDetailCursor(shop.id, current.id, "related", "next", {
      at: now, id: foreignRecovery.id,
    });
    const afterForeignRecovery = await read.related(principal, current.id,
      new URLSearchParams({ cursor: foreignRecoveryCursor }));
    assert.deepEqual(afterForeignRecovery?.items.map(item => item.id), expectedRelated.slice(0, 5).map(item => item.id));
    assert.equal(afterForeignRecovery?.items.some(item => item.id === foreignRecovery.id), false);

    await db.conversationMessage.delete({ where: { id: expectedMessages[49]!.id } });
    const afterDeletedBoundary = await read.messages(principal, current.id,
      new URLSearchParams({ cursor: navFirst!.nextCursor! }));
    assert.deepEqual(afterDeletedBoundary?.items.map(item => item.id), expectedMessages.slice(50, 100).map(item => item.id));
    await db.checkoutRecovery.delete({ where: { id: expectedRelated[4]!.id } });
    const afterDeletedRelatedBoundary = await read.related(principal, current.id,
      new URLSearchParams({ cursor: relatedNavFirst!.nextCursor! }));
    assert.deepEqual(afterDeletedRelatedBoundary?.items.map(item => item.id), expectedRelated.slice(5, 10).map(item => item.id));
    assert.equal(statements.every(statement => statement.duration >= 0), true);
  } finally {
    if (shopIds.length) await db.shop.deleteMany({ where: { id: { in: shopIds } } });
    await db.$disconnect();
  }
});