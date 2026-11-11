import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WooReadAuthorizationError } from "../../../../src/woocommerce/rest-read/authorization.service.js";
import { digestSecret } from "../../../../src/auth/woo-installation/credential.js";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { loadWooRestReadAuthorizationConfig } from "../../../../src/woocommerce/rest-read/config.js";
import { WooReadAuthorizationService } from "../../../../src/woocommerce/rest-read/authorization.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const configuration = loadWooRestReadAuthorizationConfig({
  MODA_WOO_REST_READ_PUBLIC_ORIGIN: "https://api.test.invalid",
  MODA_ENCRYPTION_ACTIVE_KEY_ID: "fixture-v1",
  MODA_ENCRYPTION_KEYS_JSON: JSON.stringify({ "fixture-v1": Buffer.alloc(32, 8).toString("base64") }),
}, "public");
assert.ok(configuration);
const clients = new Set<PrismaClient>();
after(async () => Promise.all([...clients].map(client => client.$disconnect())));

function client(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  const instance = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  clients.add(instance);
  return instance;
}

async function setup() {
  const db = client();
  const domain = `https://arch055-read-${randomUUID()}.invalid`;
  const shop = await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE" } });
  const installation = await db.wooCommerceInstallation.create({ data: {
    shopId: shop.id, canonicalSiteUrl: domain,
    credentialDigest: Uint8Array.from(digestSecret(Buffer.alloc(32, 7))),
  } });
  const principal: WooInstallationPrincipal = {
    shopId: shop.id, installationId: installation.id, canonicalSiteUrl: domain,
    credentialVersion: installation.credentialVersion,
  };
  return { db, shop, principal };
}

function service(db: PrismaClient, verifier: () => Promise<void> = async () => {}, now: () => Date = () => new Date()) {
  return new WooReadAuthorizationService(db, configuration!, "public", { verify: verifier }, now);
}

function consent(url: string) {
  const parsed = new URL(url);
  return {
    userId: parsed.searchParams.get("user_id")!,
    token: new URL(parsed.searchParams.get("callback_url")!).pathname.split("/").at(-1)!,
  };
}

const payload = (userId: string) => ({
  user_id: userId, key_id: 42, key_permissions: "read" as const,
  consumer_key: `ck_${"a".repeat(40)}`, consumer_secret: `cs_${"b".repeat(40)}`,
});

test("PostgreSQL overlapping callbacks acknowledge one durable grant without a second rotation", { skip: !databaseUrl }, async () => {
  const { db, shop, principal } = await setup();
  const created = consent((await service(db).start(principal)).authorizationUrl);
  let arrivals = 0;
  let release!: () => void;
  const bothVerified = new Promise<void>(resolve => { release = resolve; });
  let verifications = 0;
  const verify = async () => {
    verifications += 1;
    arrivals += 1;
    if (arrivals === 2) release();
    await bothVerified;
  };
  try {
    const results = await Promise.allSettled([
      service(db, verify).callback(created.token, payload(created.userId)),
      service(client(), verify).callback(created.token, payload(created.userId)),
    ]);
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"]);
    assert.equal(verifications, 2);
    const grant = await db.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId: principal.installationId } });
    assert.equal(grant.authorizationAttemptId, created.userId);
    assert.equal(grant.rotationVersion, 1);
  } finally {
    await db.shop.deleteMany({ where: { id: shop.id } });
  }
});

test("PostgreSQL revoke fails expired current attempts and ignores pending attempts from older generations", { skip: !databaseUrl }, async () => {
  const { db, shop, principal } = await setup();
  const operations = service(db);
  let releaseAttempt: (() => void) | undefined;
  let lockTransaction: Promise<void> = Promise.resolve();
  let revokeTransaction: Promise<unknown> = Promise.resolve();
  try {
    const first = consent((await operations.start(principal)).authorizationUrl);
    await operations.callback(first.token, payload(first.userId));
    const expiresAt = new Date(Date.now() + 2_000);
    const expiredCurrent = await db.wooCommerceRestReadAttempt.create({ data: {
      installationId: principal.installationId,
      shopId: principal.shopId,
      credentialVersionSnapshot: principal.credentialVersion,
      tokenDigest: Uint8Array.from(digestSecret(randomBytes(32))),
      expiresAt,
    } });
    const locker = client();
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const rowLocked = new Promise<void>(resolve => { locked = resolve; });
    releaseAttempt = release;
    lockTransaction = locker.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "woocommerce"."WooCommerceRestReadAttempt" WHERE "id" = ${expiredCurrent.id} FOR UPDATE`;
      locked();
      await released;
    });
    await rowLocked;
    const revokeStartedAt = new Date();
    revokeTransaction = operations.revoke(principal);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await db.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%WooCommerceRestReadAttempt%'
        ) AS waiting`;
      if (rows[0]?.waiting) {
        waiting = true;
        break;
      }
      await delay(25);
    }
    assert.equal(waiting, true, "revoke must reach the locked attempt update before expiry");
    await delay(Math.max(0, expiresAt.getTime() - Date.now() + 50));
    releaseAttempt();
    await Promise.all([lockTransaction, revokeTransaction]);
    const failedAttempt = await db.wooCommerceRestReadAttempt.findUniqueOrThrow({ where: { id: expiredCurrent.id } });
    assert.equal(failedAttempt.status, "FAILED");
    assert.ok(failedAttempt.consumedAt && failedAttempt.consumedAt >= revokeStartedAt);
    assert.notEqual(failedAttempt.consumedAt?.getTime(), expiresAt.getTime());
    assert.equal((await db.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId: principal.installationId } })).status, "REVOKED");

    const nextPrincipal = { ...principal, credentialVersion: principal.credentialVersion + 1 };
    await db.wooCommerceInstallation.update({ where: { id: principal.installationId }, data: {
      credentialVersion: nextPrincipal.credentialVersion, status: "ACTIVE", revokedAt: null,
    } });
    const oldPending = consent((await service(db).start(nextPrincipal)).authorizationUrl);
    const currentPrincipal = { ...nextPrincipal, credentialVersion: nextPrincipal.credentialVersion + 1 };
    await db.wooCommerceInstallation.update({ where: { id: principal.installationId }, data: {
      credentialVersion: currentPrincipal.credentialVersion,
    } });
    const currentPending = consent((await service(db).start(currentPrincipal)).authorizationUrl);
    await service(db).revoke(currentPrincipal);
    assert.equal((await db.wooCommerceRestReadAttempt.findUniqueOrThrow({ where: { id: oldPending.userId } })).status, "PENDING");
    assert.equal((await db.wooCommerceRestReadAttempt.findUniqueOrThrow({ where: { id: currentPending.userId } })).status, "FAILED");
    assert.equal((await db.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId: principal.installationId } })).status, "REVOKED");
  } finally {
    releaseAttempt?.();
    await Promise.allSettled([lockTransaction, revokeTransaction]);
    await db.shop.deleteMany({ where: { id: shop.id } });
  }
});

test("PostgreSQL callback rejects a Shop suspended during provider verification", { skip: !databaseUrl }, async () => {
  const { db, shop, principal } = await setup();
  const created = consent((await service(db).start(principal)).authorizationUrl);
  let release!: () => void;
  let entered!: () => void;
  const verificationEntered = new Promise<void>(resolve => { entered = resolve; });
  const verificationReleased = new Promise<void>(resolve => { release = resolve; });
  let verifications = 0;
  const operation = service(db, async () => {
    verifications += 1;
    entered();
    await verificationReleased;
  }).callback(created.token, payload(created.userId));
  try {
    await verificationEntered;
    await client().shop.update({ where: { id: shop.id }, data: { status: "SUSPENDED" } });
    release();
    await assert.rejects(operation, error => error instanceof WooReadAuthorizationError &&
      error.status === 409 && error.code === "shop_unavailable");
    assert.equal(verifications, 1);
    assert.equal((await db.wooCommerceRestReadAttempt.findUniqueOrThrow({ where: { id: created.userId } })).status, "PENDING");
    assert.equal(await db.wooCommerceRestReadGrant.count({ where: { installationId: principal.installationId } }), 0);
  } finally {
    release();
    await db.shop.deleteMany({ where: { id: shop.id } });
  }
});

test("PostgreSQL revoke rolls back attempt cancellation when grant revocation fails", { skip: !databaseUrl }, async () => {
  const { db, shop, principal } = await setup();
  try {
    const operations = service(db);
    const completed = consent((await operations.start(principal)).authorizationUrl);
    await operations.callback(completed.token, payload(completed.userId));
    const pending = consent((await operations.start(principal)).authorizationUrl);
    const failingDatabase = {
      wooCommerceRestReadAttempt: db.wooCommerceRestReadAttempt,
      wooCommerceRestReadGrant: db.wooCommerceRestReadGrant,
      $transaction: (operation: (tx: never) => Promise<unknown>, options: never) => db.$transaction(tx => {
        const proxy = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "wooCommerceRestReadGrant") {
              const grantDelegate = Reflect.get(target, property, receiver) as object;
              return new Proxy(grantDelegate, {
                get(delegate, method, delegateReceiver) {
                  if (method === "updateMany") return async () => { throw new Error("injected grant write failure"); };
                  const value = Reflect.get(delegate, method, delegateReceiver) as unknown;
                  return typeof value === "function" ? value.bind(delegate) : value;
                },
              });
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(proxy as never);
      }, options),
    };
    await assert.rejects(service(failingDatabase as never).revoke(principal), /injected grant write failure/);
    assert.equal((await db.wooCommerceRestReadAttempt.findUniqueOrThrow({ where: { id: pending.userId } })).status, "PENDING");
    assert.equal((await db.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId: principal.installationId } })).status, "ACTIVE");
  } finally {
    await db.shop.deleteMany({ where: { id: shop.id } });
  }
});

test("PostgreSQL captures latest-attempt ordering plan with 256 historical attempts", { skip: !databaseUrl }, async () => {
  const { db, shop, principal } = await setup();
  try {
    await db.wooCommerceRestReadAttempt.createMany({ data: Array.from({ length: 256 }, () => ({
      installationId: principal.installationId,
      shopId: principal.shopId,
      credentialVersionSnapshot: principal.credentialVersion,
      tokenDigest: Uint8Array.from(digestSecret(randomBytes(32))),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })) });
    await db.$executeRaw`ANALYZE "woocommerce"."WooCommerceRestReadAttempt"`;
    const plan = await db.$queryRaw<{ "QUERY PLAN": string }[]>`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT "status", "expiresAt", "credentialVersionSnapshot"
      FROM "woocommerce"."WooCommerceRestReadAttempt"
      WHERE "installationId" = ${principal.installationId} AND "shopId" = ${principal.shopId}
      ORDER BY "attemptSequence" DESC
      LIMIT 1`;
    assert.ok(plan.length > 0);
    console.info(`ARCH-055 latest-attempt plan; rows=256; existing indexes only:\n${plan.map(row => row["QUERY PLAN"]).join("\n")}`);
  } finally {
    await db.shop.deleteMany({ where: { id: shop.id } });
  }
});