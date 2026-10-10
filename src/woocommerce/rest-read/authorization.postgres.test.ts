import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { WooReadAuthorizationService, WooReadAuthorizationError } from "./authorization.service.js";
import { openWooReadCredentials } from "./envelope.js";
import { loadWooRestReadAuthorizationConfig } from "./config.js";
import { digestSecret } from "../installation/credential.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const configuration = loadWooRestReadAuthorizationConfig({
  MODA_WOO_REST_READ_PUBLIC_ORIGIN: "https://api.test.invalid",
  MODA_WOO_REST_READ_ACTIVE_KEY_ID: "fixture-v1",
  MODA_WOO_REST_READ_KEYRING: JSON.stringify({ "fixture-v1": Buffer.alloc(32, 8).toString("base64url") }),
}, "public");
assert.ok(configuration);

const fixtureCredentials = {
  consumer_key: `ck_${"a".repeat(40)}`,
  consumer_secret: `cs_${"b".repeat(40)}`,
  key_id: 123,
  key_permissions: "read" as const,
};

async function withShop(run: (prisma: PrismaClient, context: {
  installationId: string; shopId: string; canonicalSiteUrl: string; credentialVersion: number;
}) => Promise<void>): Promise<void> {
  if (!databaseUrl) throw new Error("disposable test database URL is required");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const domain = `https://woo-${randomUUID()}.test.invalid`;
  const shop = await prisma.shop.create({ data: { domain, platform: "WOOCOMMERCE", status: "ACTIVE", shopifyShopId: null } });
  const installation = await prisma.wooCommerceInstallation.create({ data: {
    shopId: shop.id, canonicalSiteUrl: domain, credentialDigest: Uint8Array.from(digestSecret(Buffer.alloc(32, 7))),
    status: "ACTIVE", credentialVersion: 1, credentialIssuedAt: new Date(),
  } });
  try {
    await run(prisma, { installationId: installation.id, shopId: shop.id, canonicalSiteUrl: domain, credentialVersion: 1 });
  } finally {
    await prisma.shop.delete({ where: { id: shop.id } });
    await prisma.$disconnect();
  }
}

function service(prisma: PrismaClient): WooReadAuthorizationService {
  return new WooReadAuthorizationService(prisma, configuration!, "public", { verify: async () => undefined });
}

function decodeConsent(authorizationUrl: string): { token: string; userId: string } {
  const consent = new URL(authorizationUrl);
  assert.equal(consent.searchParams.get("scope"), "read");
  const callbackUrl = new URL(consent.searchParams.get("callback_url") ?? "");
  const userId = consent.searchParams.get("user_id") ?? "";
  return { userId, token: callbackUrl.pathname.split("/").at(-1) ?? "" };
}

test("PostgreSQL atomic callback, ciphertext storage, idempotent replay and local revocation", { skip: !databaseUrl }, async () => {
  await withShop(async (prisma, principal) => {
    const operations = service(prisma);
    const start = await operations.start(principal);
    const { token, userId } = decodeConsent(start.authorizationUrl);
    assert.equal((await operations.status(principal)).status, "PENDING");
    await operations.callback(token, { ...fixtureCredentials, user_id: userId });
    const selected = await prisma.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId: principal.installationId } });
    assert.equal(selected.status, "ACTIVE");
    assert.equal(selected.authorizedScope, "read");
    assert.equal(selected.credentialVersionSnapshot, 1);
    assert.equal(Buffer.from(selected.credentialCiphertext).includes(Buffer.from(fixtureCredentials.consumer_secret)), false);
    assert.equal(Buffer.from(selected.credentialCiphertext).includes(Buffer.from(fixtureCredentials.consumer_key)), false);
    assert.deepEqual(openWooReadCredentials({
      credentialCiphertext: Buffer.from(selected.credentialCiphertext),
      credentialNonce: Buffer.from(selected.credentialNonce),
      credentialAuthTag: Buffer.from(selected.credentialAuthTag),
      encryptionKeyId: selected.encryptionKeyId,
    }, { shopId: principal.shopId, installationId: principal.installationId,
      authorizationAttemptId: selected.authorizationAttemptId, credentialVersionSnapshot: 1 }, configuration!),
    { consumerKey: fixtureCredentials.consumer_key, consumerSecret: fixtureCredentials.consumer_secret });
    assert.equal((await operations.status(principal)).status, "CONNECTED");
    await operations.callback(token, { ...fixtureCredentials, user_id: userId });
    assert.equal((await prisma.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId: principal.installationId } })).rotationVersion, 1);
    await operations.revoke(principal);
    assert.equal((await operations.status(principal)).status, "REAUTHORIZATION_REQUIRED");
    assert.equal((await prisma.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId: principal.installationId } })).status, "REVOKED");
    // A duplicate callback cannot restore a revoked grant.
    await operations.callback(token, { ...fixtureCredentials, user_id: userId });
    assert.equal((await prisma.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId: principal.installationId } })).status, "REVOKED");
  });
});

test("PostgreSQL newer consent rotates the grant; old callbacks never roll it back", { skip: !databaseUrl }, async () => {
  await withShop(async (prisma, principal) => {
    const operations = service(prisma);
    const first = decodeConsent((await operations.start(principal)).authorizationUrl);
    const second = decodeConsent((await operations.start(principal)).authorizationUrl);
    await operations.callback(second.token, { ...fixtureCredentials, user_id: second.userId });
    await assert.rejects(operations.callback(first.token, { ...fixtureCredentials, user_id: first.userId }),
      (error) => error instanceof WooReadAuthorizationError && error.code === "authorization_conflict");
    const selected = await prisma.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId: principal.installationId } });
    assert.equal(selected.authorizationAttemptId, second.userId);
    assert.equal(selected.rotationVersion, 1);
    const third = decodeConsent((await operations.start(principal)).authorizationUrl);
    await operations.callback(third.token, { ...fixtureCredentials, user_id: third.userId });
    const rotated = await prisma.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId: principal.installationId } });
    assert.equal(rotated.authorizationAttemptId, third.userId);
    assert.equal(rotated.rotationVersion, 2);
  });
});

test("PostgreSQL reconnect generation change denies a stale pending grant", { skip: !databaseUrl }, async () => {
  await withShop(async (prisma, principal) => {
    const operations = service(prisma);
    const start = decodeConsent((await operations.start(principal)).authorizationUrl);
    await prisma.wooCommerceInstallation.update({ where: { id: principal.installationId }, data: { credentialVersion: 2 } });
    await assert.rejects(operations.callback(start.token, { ...fixtureCredentials, user_id: start.userId }),
      (error) => error instanceof WooReadAuthorizationError && error.code === "shop_unavailable");
    assert.equal(await prisma.wooCommerceRestReadGrant.count({ where: { installationId: principal.installationId } }), 0);
  });
});
