import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import { WooMutationPrincipalConflictError } from
  "../../../../src/auth/woo-installation/current-mutation-principal.js";
import { digestSecret } from "../../../../src/auth/woo-installation/credential.js";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { loadWooRestReadAuthorizationConfig } from "../../../../src/woocommerce/rest-read/config.js";
import { WooReadAuthorizationError, WooReadAuthorizationService } from
  "../../../../src/woocommerce/rest-read/authorization.service.js";

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

function gate() {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, pause: async () => { markEntered(); await released; } };
}

function gatedDatabase(db: PrismaClient, barrier: ReturnType<typeof gate>) {
  return {
    wooCommerceRestReadAttempt: db.wooCommerceRestReadAttempt,
    wooCommerceRestReadGrant: db.wooCommerceRestReadGrant,
    $transaction: (operation: (tx: never) => Promise<unknown>, options: unknown) =>
      db.$transaction(async transaction => {
        let paused = false;
        const proxy = new Proxy(transaction, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;
            if (property === "$queryRaw" && typeof value === "function") {
              return async (...args: unknown[]) => {
                if (!paused) { paused = true; await barrier.pause(); }
                return Reflect.apply(value, target, args);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(proxy as never);
      }, options as never),
  };
}

function service(db: PrismaClient, verifier = async () => undefined, barrier?: ReturnType<typeof gate>) {
  const source = barrier ? gatedDatabase(db, barrier) : db;
  return new WooReadAuthorizationService(source as never, configuration!, "public", { verify: verifier });
}

async function setup() {
  const db = client();
  const domain = `https://arch055-${randomUUID()}.invalid`;
  const shop = await db.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE" } });
  const installation = await db.wooCommerceInstallation.create({ data: {
    shopId: shop.id, canonicalSiteUrl: domain,
    credentialDigest: Uint8Array.from(digestSecret(Buffer.alloc(32, 7))),
  } });
  const principal: WooInstallationPrincipal = {
    shopId: shop.id, installationId: installation.id, canonicalSiteUrl: domain,
    credentialVersion: installation.credentialVersion,
  };
  return { db, shop, installation, principal };
}

async function remove(db: PrismaClient, shopId: string): Promise<void> {
  await db.shop.deleteMany({ where: { id: shopId } });
}

function consent(url: string) {
  const parsed = new URL(url);
  return {
    userId: parsed.searchParams.get("user_id")!,
    token: new URL(parsed.searchParams.get("callback_url")!).pathname.split("/").at(-1)!,
  };
}

const callbackPayload = (userId: string) => ({
  user_id: userId, key_id: 42, key_permissions: "read" as const,
  consumer_key: `ck_${"a".repeat(40)}`, consumer_secret: `cs_${"b".repeat(40)}`,
});

test("PostgreSQL gate rejects a generation rotated while authenticated start waits", { skip: !databaseUrl }, async () => {
  const { db, shop, principal } = await setup();
  const barrier = gate();
  const operation = service(db, undefined, barrier).start(principal);
  try {
    await barrier.entered;
    await client().wooCommerceInstallation.update({ where: { id: principal.installationId },
      data: { credentialVersion: { increment: 1 } } });
    barrier.release();
    await assert.rejects(operation, (error: unknown) => error instanceof WooReadAuthorizationError &&
      error.status === 409 && error.code === "shop_unavailable" &&
      error.cause instanceof WooMutationPrincipalConflictError);
    assert.equal(await db.wooCommerceRestReadAttempt.count({ where: { installationId: principal.installationId } }), 0);
  } finally {
    barrier.release();
    await remove(db, shop.id);
  }
});

test("PostgreSQL gate rejects stale revoke without cancelling or revoking anything", { skip: !databaseUrl }, async () => {
  const { db, shop, principal } = await setup();
  const base = service(db);
  const started = consent((await base.start(principal)).authorizationUrl);
  const barrier = gate();
  const operation = service(db, undefined, barrier).revoke(principal);
  try {
    await barrier.entered;
    await client().wooCommerceInstallation.update({ where: { id: principal.installationId },
      data: { credentialVersion: { increment: 1 } } });
    barrier.release();
    await assert.rejects(operation, (error: unknown) => error instanceof WooReadAuthorizationError &&
      error.status === 409 && error.code === "shop_unavailable");
    assert.equal((await db.wooCommerceRestReadAttempt.findUniqueOrThrow({ where: { id: started.userId } })).status, "PENDING");
    assert.equal(await db.wooCommerceRestReadGrant.count({ where: { installationId: principal.installationId } }), 0);
  } finally {
    barrier.release();
    await remove(db, shop.id);
  }
});

test("PostgreSQL callback revalidates after exactly one verification when installation rotates", { skip: !databaseUrl }, async () => {
  const { db, shop, principal } = await setup();
  const created = consent((await service(db).start(principal)).authorizationUrl);
  const barrier = gate();
  let verifications = 0;
  const operation = service(db, async () => { verifications += 1; }, barrier)
    .callback(created.token, callbackPayload(created.userId));
  try {
    await barrier.entered;
    await client().wooCommerceInstallation.update({ where: { id: principal.installationId },
      data: { credentialVersion: { increment: 1 } } });
    barrier.release();
    await assert.rejects(operation, (error: unknown) => error instanceof WooReadAuthorizationError &&
      error.status === 409 && error.code === "shop_unavailable");
    assert.equal(verifications, 1);
    assert.equal((await db.wooCommerceRestReadAttempt.findUniqueOrThrow({ where: { id: created.userId } })).status, "PENDING");
    assert.equal(await db.wooCommerceRestReadGrant.count({ where: { installationId: principal.installationId } }), 0);
  } finally {
    barrier.release();
    await remove(db, shop.id);
  }
});
