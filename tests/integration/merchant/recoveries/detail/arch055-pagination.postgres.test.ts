import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { MerchantRecoveryDetailService } from "../../../../../src/merchant/recoveries/detail/read.service.js";
import { MerchantRecoveryListService } from "../../../../../src/merchant/recoveries/list.service.js";
import { encodeDetailCursor } from "../../../../../src/merchant/recoveries/detail/cursor.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

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
    const read = new MerchantRecoveryDetailService(db);
    const navFirst = await read.messages(principal, current.id, new URLSearchParams());
    const navNext = await read.messages(principal, current.id,
      new URLSearchParams({ cursor: navFirst!.nextCursor! }));
    const relatedNavFirst = await read.related(principal, current.id, new URLSearchParams());
    const relatedNavNext = await read.related(principal, current.id,
      new URLSearchParams({ cursor: relatedNavFirst!.nextCursor! }));
    const profiles: Array<{ name: string; run: () => Promise<number> }> = [
      { name: "messages.first", run: async () => (await read.messages(principal, current.id, new URLSearchParams()))!.items.length },
      { name: "messages.latest", run: async () => (await read.messages(principal, current.id,
        new URLSearchParams({ window: "latest" })))!.items.length },
      { name: "messages.next", run: async () => (await read.messages(principal, current.id,
        new URLSearchParams({ cursor: navFirst!.nextCursor! })))!.items.length },
      { name: "messages.previous", run: async () => (await read.messages(principal, current.id,
        new URLSearchParams({ cursor: navNext!.previousCursor! })))!.items.length },
      { name: "related.first", run: async () => (await read.related(principal, current.id, new URLSearchParams()))!.items.length },
      { name: "related.next", run: async () => (await read.related(principal, current.id,
        new URLSearchParams({ cursor: relatedNavFirst!.nextCursor! })))!.items.length },
      { name: "related.previous", run: async () => (await read.related(principal, current.id,
        new URLSearchParams({ cursor: relatedNavNext!.previousCursor! })))!.items.length },
      { name: "list.zero", run: async () => (await new MerchantRecoveryListService(db, () => now).read(
        principal, new URLSearchParams({ from: "2026-10-01", to: "2026-10-02" }))).items.length },
    ];
    if (process.env.ARCH055_MEASURE_VERSION) {
      const measurements = [];
      for (const profile of profiles) {
        const samples: Array<{ elapsedMs: number; sql: Array<{ shape: string; durationMs: number }> }> = [];
        let rowsReturned = 0;
        for (let execution = 0; execution < 7; execution += 1) {
          statements.length = 0;
          const startedAt = performance.now();
          rowsReturned = await profile.run();
          const elapsedMs = performance.now() - startedAt;
          if (execution >= 2) samples.push({ elapsedMs, sql: statements.map(statement => ({
            shape: statement.query.replace(/\$\d+/g, "?").replace(/\s+/g, " ").trim(),
            durationMs: statement.duration,
          })) });
        }
        const elapsed = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
        const sqlShapes = [...new Set(samples.flatMap(sample => sample.sql.map(query => query.shape)))];
        measurements.push({ profile: profile.name, warmups: 2, clientCallsPerSample: 1,
          rowsReturned, affectedRows: 0, elapsedMs: samples.map(sample => sample.elapsedMs),
          sqlDurationSamples: samples.map(sample => sample.sql.map(query => query.durationMs)),
          sqlShapes, sqlShapeIndexesPerSample: samples.map(sample => sample.sql.map(query =>
            [sqlShapes.indexOf(query.shape), query.durationMs])),
          minMs: elapsed[0], medianMs: elapsed[2], maxMs: elapsed[4] });
      }
      for (const measurement of measurements) {
        const minimum = measurement.minMs ?? 0;
        const median = measurement.medianMs ?? 0;
        const maximum = measurement.maxMs ?? 0;
        console.log(`ARCH055-M06-${process.env.ARCH055_MEASURE_VERSION} ${measurement.profile} ` +
          `rows=${measurement.rowsReturned} ms=${measurement.elapsedMs.map(value => value.toFixed(2)).join(",")} ` +
          `range=${minimum.toFixed(2)}/${median.toFixed(2)}/${maximum.toFixed(2)} ` +
          `clientCalls=1 affectedRows=0 externalCalls=0 ` +
          `sqlCalls=${measurement.sqlShapeIndexesPerSample.map(sample => sample.length).join(",")} ` +
          `sqlMs=${measurement.sqlDurationSamples.map(sample => sample.map(value => value.toFixed(2)).join(",")).join("/")} ` +
          `sqlShapes=${measurement.sqlShapes.map(shape => {
            const table = shape.match(/(?:FROM|UPDATE|INTO) "([^"]+)"\."([^"]+)"/)?.slice(1).join(".") ?? "transaction";
            const operation = shape.startsWith("SELECT") ? (shape.includes("COUNT(") ? "count" : "select") :
              shape.split(" ")[0]!.toLowerCase();
            return `${table}:${operation}`;
          }).join("|")}`);
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