import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { digestSecret, encodeSecret } from "../../../../src/auth/woo-installation/credential.js";
import { createWooShopBrandRoute } from "../../../../src/woocommerce/shop-brand/routes.js";
import { WooShopBrandService } from "../../../../src/woocommerce/shop-brand/service.js";
import type { WooShopBrandSnapshot } from "../../../../src/woocommerce/shop-brand/contract.js";

const databaseUrl = process.env.WOO_SHOP_BRAND_TEST_DATABASE_URL;

function createTestDatabaseClient(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_SHOP_BRAND_TEST_DATABASE_URL is required");
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [{ emit: "event", level: "query" }] });
  client.$on("query", event => queryEvents.push(event.query));
  return client;
}
const queryEvents: string[] = [];
const observed = "2026-10-27T11:55:00.000Z";
const clock = new Date("2026-10-27T12:00:00.000Z");
const logo = (url: string, id = 123) => ({
  url, attachmentId: id, altText: "Shop logo", width: 1200, height: 400,
});
const icon = (url: string) => ({
  url, attachmentId: 456, altText: null, width: 512, height: 512,
});
const snapshot = (observedAt = observed): WooShopBrandSnapshot => ({
  schemaVersion: "woo.shop-brand.v1", eventId: "brand.fixture.1", observedAt,
  brandName: "Shop 1", logo: logo("https://shop-one.invalid/logo.png"),
  siteIcon: icon("https://shop-one.invalid/icon.png"), coverImage: null,
});

type Role = { source: { url: string | null; reference: string | null; fingerprint: string | null;
  generation: number; observedAt: string }; work: { status: string; attempts: number; leaseOwner: string | null };
  ready: null | Record<string, unknown> };
type Media = { schemaVersion: 1; roles: Record<"LOGO" | "SQUARE_LOGO" | "COVER_IMAGE", Role> };
const asMedia = (value: unknown): Media => value as Media;

function statementsSince(offset: number): string[] {
  return queryEvents.slice(offset).filter(query => !/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/i.test(query.trim()));
}

async function setup(db: PrismaClient) {
  const shop = await db.shop.create({ data: {
    domain: `https://shop-brand-${randomUUID()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
  } });
  const otherShop = await db.shop.create({ data: {
    domain: `https://shop-brand-${randomUUID()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
  } });
  const secret = Buffer.alloc(32, 0x42);
  const otherSecret = Buffer.alloc(32, 0x43);
  const installation = await db.wooCommerceInstallation.create({ data: {
    shopId: shop.id, canonicalSiteUrl: shop.domain, credentialDigest: Uint8Array.from(digestSecret(secret)),
  } });
  const otherInstallation = await db.wooCommerceInstallation.create({ data: {
    shopId: otherShop.id, canonicalSiteUrl: otherShop.domain,
    credentialDigest: Uint8Array.from(digestSecret(otherSecret)),
  } });
  return {
    shop, otherShop, installation, otherInstallation, secret, otherSecret,
    principal: { shopId: shop.id, installationId: installation.id,
      canonicalSiteUrl: shop.domain, credentialVersion: installation.credentialVersion },
  };
}

const logger = { info() {}, warn() {}, error() {} } as never;

test("real PostgreSQL: insert, duplicate/stale ordering, metadata-only refresh, generation and removal", {
  skip: !databaseUrl,
}, async () => {
  const db = createTestDatabaseClient();
  try {
    const { shop, otherShop, principal } = await setup(db);
    const service = new WooShopBrandService(db, () => clock);
    const first = snapshot();
    assert.deepEqual(await service.record(principal, first), { status: "updated" });
    const original = await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } });
    assert.equal(original.brandName, "Shop 1");
    assert.equal(original.logoUrl, first.logo!.url);
    assert.equal(original.squareLogoUrl, first.siteIcon!.url);
    assert.equal(original.coverImageUrl, null);
    assert.equal(original.logoWidth, 1200);
    assert.equal(original.logoHeight, 400);
    assert.equal(original.id, (await db.shop.findUniqueOrThrow({ where: { id: shop.id },
      include: { brand: true } })).brand?.id);
    const media = asMedia(original.whatsAppMedia);
    assert.equal(media.schemaVersion, 1);
    assert.equal(media.roles.LOGO.source.generation, 1);
    assert.match(media.roles.LOGO.source.fingerprint!, /^sha256:[0-9a-f]{64}$/);
    assert.equal(media.roles.LOGO.work.status, "PENDING");
    assert.equal(media.roles.SQUARE_LOGO.work.status, "PENDING");
    assert.equal(media.roles.COVER_IMAGE.work.status, "MISSING");
    assert.equal(media.roles.COVER_IMAGE.source.url, null);
    assert.equal(await db.shopBrand.findUnique({ where: { shopId: otherShop.id } }), null);

    assert.deepEqual(await service.record(principal, { ...first, eventId: "new-id-same-snapshot" }),
      { status: "unchanged" });
    assert.deepEqual(await service.record(principal, { ...first, eventId: "old", observedAt: "2026-10-27T11:54:00.000Z",
      logo: logo("https://shop-one.invalid/old.png") }), { status: "unchanged" });
    await assert.rejects(service.record(principal, { ...first, eventId: "equal-conflict",
      logo: logo("https://shop-one.invalid/equal.png") }),
      (error: unknown) => error instanceof Error && error.message === "invalid_request");
    assert.equal((await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } })).logoUrl, first.logo!.url);

    // Simulate a processed READY asset. Metadata-only observation must preserve
    // source generation/READY. Subsequent source change must make READY stale.
    const ready = {
      sourceGeneration: 1, sourceFingerprint: media.roles.SQUARE_LOGO.source.fingerprint,
      objectKey: "shop-brands/square/sha256-test.jpg", contentType: "image/jpeg",
      width: 1125, height: 600, sizeBytes: 1000,
      contentSha256: "a".repeat(64), verifiedAt: clock.toISOString(),
    };
    media.roles.SQUARE_LOGO.work.status = "READY";
    media.roles.SQUARE_LOGO.ready = ready;
    await db.$executeRaw(Prisma.sql`
      UPDATE "commerce"."ShopBrand" SET "whatsAppMedia" = CAST(${JSON.stringify(media)} AS jsonb)
      WHERE "shopId" = ${shop.id}
    `);
    const metadata = { ...first, observedAt: "2026-10-27T11:56:00.000Z", eventId: "metadata",
      logo: { ...first.logo!, altText: "New logo label", width: 900 } };
    assert.deepEqual(await service.record(principal, metadata), { status: "updated" });
    const unchangedSource = asMedia((await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } })).whatsAppMedia);
    assert.equal(unchangedSource.roles.LOGO.source.generation, 1);
    assert.equal(unchangedSource.roles.SQUARE_LOGO.source.generation, 1);
    assert.equal(unchangedSource.roles.SQUARE_LOGO.work.status, "READY");
    assert.deepEqual(unchangedSource.roles.SQUARE_LOGO.ready, ready);

    const changed = { ...metadata, observedAt: "2026-10-27T11:57:00.000Z", eventId: "new-logo",
      logo: logo("https://shop-one.invalid/replacement.png") };
    await service.record(principal, changed);
    const newSource = asMedia((await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } })).whatsAppMedia);
    assert.equal(newSource.roles.LOGO.source.generation, 2);
    assert.equal(newSource.roles.LOGO.work.status, "PENDING");
    assert.equal(newSource.roles.SQUARE_LOGO.source.generation, 1);
    assert.equal(newSource.roles.SQUARE_LOGO.work.status, "READY");
    assert.deepEqual(newSource.roles.SQUARE_LOGO.ready, ready);

    const cleared = { ...changed, observedAt: "2026-10-27T11:58:00.000Z", eventId: "removed",
      logo: null, siteIcon: null, brandName: null };
    await service.record(principal, cleared);
    const removed = await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } });
    const removedMedia = asMedia(removed.whatsAppMedia);
    assert.equal(removed.brandName, null);
    assert.equal(removed.logoUrl, null);
    assert.equal(removed.squareLogoUrl, null);
    assert.equal(removedMedia.roles.LOGO.source.generation, 3);
    assert.equal(removedMedia.roles.LOGO.work.status, "MISSING");
    assert.equal(removedMedia.roles.SQUARE_LOGO.source.generation, 2);
    assert.equal(removedMedia.roles.SQUARE_LOGO.work.status, "MISSING");
    assert.notEqual(removedMedia.roles.SQUARE_LOGO.ready?.sourceGeneration,
      removedMedia.roles.SQUARE_LOGO.source.generation);
    assert.equal(removedMedia.roles.COVER_IMAGE.source.generation, 1);
    assert.equal(removedMedia.roles.COVER_IMAGE.work.status, "MISSING");
    assert.equal(removed.id, original.id);
    assert.equal(await db.shopBrand.count({ where: { shopId: shop.id } }), 1);
    await assert.rejects(service.record(principal, { ...cleared,
      observedAt: "2026-10-27T12:05:01.000Z" }),
    (error: unknown) => error instanceof Error && error.message === "invalid_request");
  } finally { await db.$disconnect(); }
});

test("real PostgreSQL captures baseline and current SQL for first ShopBrand creation", {
  skip: !databaseUrl,
}, async () => {
  const db = createTestDatabaseClient();
  try {
    const shop = await db.shop.create({ data: {
      domain: `https://shop-brand-measure-${randomUUID()}.invalid`, platform: "WOOCOMMERCE", status: "ACTIVE",
    } });
    const secret = Buffer.alloc(32, 0x55);
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain, credentialDigest: Uint8Array.from(digestSecret(secret)),
    } });
    const request = { rawHeaders: [
      "x-moda-installation-id", installation.id,
      "authorization", `Bearer ${encodeSecret(secret)}`,
    ] } as never;

    const baselineStart = queryEvents.length;
    const baselinePrincipal = await new WooInstallationAuthenticator(db).authenticate(request);
    await db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id", "domain", "platform"::text AS "platform", "status"::text AS "status", "shopifyShopId"
        FROM "commerce"."Shop" WHERE "id" = ${baselinePrincipal.shopId} FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id", "shopId", "canonicalSiteUrl", "credentialVersion", "status"::text AS "status", "revokedAt"
        FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${baselinePrincipal.installationId} FOR SHARE
      `);
      const empty = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id", "brandName", "logoUrl", "logoAltText", "logoWidth", "logoHeight",
          "squareLogoUrl", "squareLogoAltText", "coverImageUrl", "whatsAppMedia"
        FROM "commerce"."ShopBrand" WHERE "shopId" = ${baselinePrincipal.shopId} FOR UPDATE
      `);
      assert.equal(empty.length, 0);
      const created = await tx.shopBrand.create({ data: { shopId: baselinePrincipal.shopId } });
      assert.ok(created.id);
      const reread = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id", "brandName", "logoUrl", "logoAltText", "logoWidth", "logoHeight",
          "squareLogoUrl", "squareLogoAltText", "coverImageUrl", "whatsAppMedia"
        FROM "commerce"."ShopBrand" WHERE "shopId" = ${baselinePrincipal.shopId} FOR UPDATE
      `);
      assert.equal(reread.length, 1);
      const media = JSON.stringify({ schemaVersion: 1, roles: {
        LOGO: { source: { url: null, reference: null, fingerprint: null, generation: 1, observedAt: observed }, work: { status: "MISSING", attempts: 0, retryAfter: null, leaseOwner: null, leaseUntil: null, failureCode: null, lastCheckedAt: null }, ready: null },
        SQUARE_LOGO: { source: { url: null, reference: null, fingerprint: null, generation: 1, observedAt: observed }, work: { status: "MISSING", attempts: 0, retryAfter: null, leaseOwner: null, leaseUntil: null, failureCode: null, lastCheckedAt: null }, ready: null },
        COVER_IMAGE: { source: { url: null, reference: null, fingerprint: null, generation: 1, observedAt: observed }, work: { status: "MISSING", attempts: 0, retryAfter: null, leaseOwner: null, leaseUntil: null, failureCode: null, lastCheckedAt: null }, ready: null },
      } });
      const affected = await tx.$executeRaw(Prisma.sql`
        UPDATE "commerce"."ShopBrand" SET
          "brandName" = ${"Shop 1"}, "logoUrl" = ${null}, "logoAltText" = ${null},
          "logoWidth" = ${null}, "logoHeight" = ${null}, "squareLogoUrl" = ${null},
          "squareLogoAltText" = ${null}, "coverImageUrl" = ${null},
          "whatsAppMedia" = CAST(${media} AS jsonb), "fetchedAt" = ${new Date(observed)},
          "lastRefreshedAt" = ${clock}
        WHERE "id" = ${created.id} AND "shopId" = ${baselinePrincipal.shopId}
      `);
      assert.equal(affected, 1);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 });
    const baselineSql = statementsSince(baselineStart);
    await db.shopBrand.deleteMany({ where: { shopId: shop.id } });

    const currentStart = queryEvents.length;
    const currentPrincipal = await new WooInstallationAuthenticator(db).authenticate(request);
    const affectedRows: number[] = [];
    const measuredDatabase = {
      $transaction: (operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
        db.$transaction(tx => operation(new Proxy(tx, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;
            if (property === "$executeRaw" && typeof value === "function") {
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(value, target, args) as number;
                affectedRows.push(result);
                return result;
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as Prisma.TransactionClient), options as never),
    };
    assert.deepEqual(await new WooShopBrandService(measuredDatabase as never, () => clock).record(currentPrincipal, snapshot()),
      { status: "updated" });
    const currentSql = statementsSince(currentStart);
    assert.equal(baselineSql.length, 8);
    assert.equal(currentSql.length, 7);
    assert.deepEqual(affectedRows, [1]);
    assert.equal(await db.shopBrand.count({ where: { shopId: shop.id } }), 1);
    console.info(`ARCH-055 first-brand SQL capture baseline statements=${baselineSql.length}, create returned rows=1, reread rows=1, UPDATE affected=1`);
    baselineSql.forEach((query, index) => console.info(`BASELINE SQL ${index + 1}: ${query}`));
    console.info(`ARCH-055 first-brand SQL capture current statements=${currentSql.length}, create projection rows=1, UPDATE affected=${affectedRows[0]}`);
    currentSql.forEach((query, index) => console.info(`CURRENT SQL ${index + 1}: ${query}`));
  } finally {
    await db.$disconnect();
  }
});

test("real PostgreSQL + actual installation HTTP auth: cross-tenant, revoked, suspended and malformed fail closed", {
  skip: !databaseUrl,
}, async () => {
  const db = createTestDatabaseClient();
  const { shop, otherShop, installation, secret, otherSecret, principal } = await setup(db);
  const route = createWooShopBrandRoute({
    authenticator: new WooInstallationAuthenticator(db), service: new WooShopBrandService(db, () => clock), logger,
  });
  const server = createServer((request, response) => {
    void route.handle(request, response).then(handled => {
      if (!handled && !response.headersSent) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const send = async (credential: Uint8Array, body: unknown, id = installation.id) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/woocommerce/shop-brand`, {
        method: "POST", headers: {
          "authorization": `Bearer ${encodeSecret(credential)}`,
          "x-moda-installation-id": id, "content-type": "application/json",
        }, body: JSON.stringify(body),
      });
      return { status: response.status, json: await response.json() as Record<string, string> };
    };
    assert.equal((await send(otherSecret, snapshot())).status, 401);
    assert.equal((await send(secret, { ...snapshot(), shopId: otherShop.id })).status, 400);
    assert.equal(await db.shopBrand.count({ where: { shopId: shop.id } }), 0);
    assert.equal(await db.shopBrand.count({ where: { shopId: otherShop.id } }), 0);
    assert.deepEqual(await send(secret, snapshot()), { status: 200, json: { status: "updated" } });
    assert.equal(await db.shopBrand.count({ where: { shopId: otherShop.id } }), 0);
    await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { status: "REVOKED", revokedAt: clock } });
    assert.equal((await send(secret, { ...snapshot(), observedAt: "2026-10-27T11:59:00.000Z" })).status, 401);
    await assert.rejects(new WooShopBrandService(db, () => clock).record(principal,
      { ...snapshot(), observedAt: "2026-10-27T11:59:00.000Z" }), WooUnauthenticatedError);
    assert.equal((await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } })).logoUrl,
      snapshot().logo!.url);
    await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { status: "ACTIVE", revokedAt: null } });
    await db.shop.update({ where: { id: shop.id }, data: { status: "SUSPENDED" } });
    assert.equal((await send(secret, { ...snapshot(), observedAt: "2026-10-27T11:59:00.000Z" })).status, 401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.$disconnect(); }
});

test("real PostgreSQL concurrency: row lock preserves worker role and newer observation wins", {
  skip: !databaseUrl,
}, async () => {
  const db = createTestDatabaseClient();
  const { shop, principal } = await setup(db);
  const service = new WooShopBrandService(db, () => clock);
  try {
    await service.record(principal, snapshot());
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { locked = resolve; });
    const worker = db.$transaction(async tx => {
      const result = await tx.$queryRaw<Array<{ whatsAppMedia: unknown }>>(Prisma.sql`
        SELECT "whatsAppMedia" FROM "commerce"."ShopBrand" WHERE "shopId" = ${shop.id} FOR UPDATE
      `);
      locked();
      await held;
      const media = asMedia(result[0]!.whatsAppMedia);
      media.roles.SQUARE_LOGO.work.status = "READY";
      media.roles.SQUARE_LOGO.ready = {
        sourceGeneration: 1, sourceFingerprint: media.roles.SQUARE_LOGO.source.fingerprint,
        objectKey: "worker-completed.jpg", contentType: "image/jpeg", width: 1125,
        height: 600, sizeBytes: 500, contentSha256: "b".repeat(64), verifiedAt: observed,
      };
      await tx.$executeRaw(Prisma.sql`
        UPDATE "commerce"."ShopBrand" SET "whatsAppMedia" = CAST(${JSON.stringify(media)} AS jsonb)
        WHERE "shopId" = ${shop.id}
      `);
    }, { timeout: 8000 });
    await entered;
    const incoming = service.record(principal, { ...snapshot("2026-10-27T11:56:00.000Z"),
      eventId: "concurrent", logo: logo("https://shop-one.invalid/new-logo.png") });
    release();
    await Promise.all([worker, incoming]);
    const media = asMedia((await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } })).whatsAppMedia);
    assert.equal(media.roles.SQUARE_LOGO.work.status, "READY");
    assert.equal(media.roles.SQUARE_LOGO.ready?.objectKey, "worker-completed.jpg");
    assert.equal(media.roles.LOGO.source.generation, 2);
    const older = { ...snapshot("2026-10-27T11:57:00.000Z"), eventId: "earlier",
      logo: logo("https://shop-one.invalid/earlier.png") };
    const latest = { ...snapshot("2026-10-27T11:58:00.000Z"), eventId: "latest",
      logo: logo("https://shop-one.invalid/latest.png") };
    await Promise.all([service.record(principal, latest), service.record(principal, older)]);
    const record = await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } });
    assert.equal(record.logoUrl, latest.logo!.url);
    assert.equal(asMedia(record.whatsAppMedia).roles.SQUARE_LOGO.ready?.objectKey, "worker-completed.jpg");
    assert.equal(await db.shopBrand.count({ where: { shopId: shop.id } }), 1);
  } finally { await db.$disconnect(); }
});
