import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import test, { after } from "node:test";
import { WooConnectionConflictError, WooInstallationConnectionService } from "./connection-service.js";
import { digestSecret } from "./credential.js";
import { WooSiteVerifier } from "./site-verifier.js";
import { canonicalizeWooSiteUrl } from "./site-url.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
let prisma: PrismaClient | undefined;

function database(): PrismaClient {
  if (!databaseUrl) throw new Error("WOO_INSTALLATION_TEST_DATABASE_URL is required");
  return prisma ??= new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

function service(verify: () => Promise<void> = async () => {}): WooInstallationConnectionService {
  const verifier = new WooSiteVerifier({ mode: "public" });
  verifier.verify = verify;
  return new WooInstallationConnectionService(database(), verifier);
}

function makeInput(siteUrl: string) {
  return {
    site: canonicalizeWooSiteUrl(siteUrl, "public"),
    attemptId: randomUUID(),
    bootstrapSecret: Buffer.alloc(32, 9),
  };
}

function uniqueSite(): string {
  return `https://${randomUUID()}.woo-integration.invalid`;
}

async function removeSite(siteUrl: string): Promise<void> {
  if (!prisma) return;
  await prisma.shop.deleteMany({ where: { domain: siteUrl } });
}

async function twoPartyBarrier(): Promise<() => Promise<void>> {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  let arrivals = 0;
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await opened;
  };
}

test("PostgreSQL first connect creates one Woo Shop and installation without Shopify settings", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  const input = makeInput(siteUrl);
  try {
    const result = await service().connect(input);
    const [shop, installation] = await Promise.all([
      database().shop.findUniqueOrThrow({ where: { id: result.shopId }, include: { settings: true } }),
      database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: result.installationId } }),
    ]);
    assert.equal(result.connection, "CREATED");
    assert.equal(result.credentialVersion, 1);
    assert.equal(shop.platform, "WOOCOMMERCE");
    assert.equal(shop.shopifyShopId, null);
    assert.equal(shop.domain, siteUrl);
    assert.equal(shop.status, "ACTIVE");
    assert.equal(shop.onboardingCompleted, false);
    assert.equal(shop.settings, null);
    assert.equal(installation.shopId, shop.id);
    assert.deepEqual(Buffer.from(installation.credentialDigest), digestSecret(Buffer.from(result.credential, "base64url")));
    assert.notDeepEqual(Buffer.from(installation.credentialDigest), digestSecret(input.bootstrapSecret));
    assert.notEqual(Buffer.from(installation.credentialDigest).toString("base64url"), result.credential);
  } finally {
    await removeSite(siteUrl);
  }
});

test("PostgreSQL reconnect preserves tenant state and rotates only the installation credential", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  try {
    const initial = await service().connect(makeInput(siteUrl));
    await database().shop.update({
      where: { id: initial.shopId },
      data: {
        status: "UNINSTALLED",
        uninstalledAt: new Date("2026-01-01T00:00:00Z"),
        reinstallPendingAt: new Date("2026-01-02T00:00:00Z"),
        onboardingCompleted: true,
        settings: { create: { onboardingCompleted: true, plan: "fixture-plan" } },
      },
    });
    const reconnect = await service().connect(makeInput(siteUrl));
    const shop = await database().shop.findUniqueOrThrow({ where: { id: initial.shopId }, include: { settings: true } });
    const installation = await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } });
    assert.equal(reconnect.connection, "RECONNECTED");
    assert.equal(reconnect.shopId, initial.shopId);
    assert.equal(reconnect.installationId, initial.installationId);
    assert.equal(reconnect.credentialVersion, initial.credentialVersion + 1);
    assert.notEqual(reconnect.credential, initial.credential);
    assert.equal(shop.status, "ACTIVE");
    assert.equal(shop.uninstalledAt, null);
    assert.equal(shop.reinstallPendingAt, null);
    assert.equal(shop.onboardingCompleted, true);
    assert.equal(shop.settings?.plan, "fixture-plan");
    assert.equal(shop.settings?.onboardingCompleted, true);
    assert.deepEqual(Buffer.from(installation.credentialDigest), digestSecret(Buffer.from(reconnect.credential, "base64url")));
  } finally {
    await removeSite(siteUrl);
  }
});

test("PostgreSQL concurrent first connects leave one tenant and one bounded loser", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  const barrier = await twoPartyBarrier();
  try {
    const attempts = await Promise.allSettled([
      service(barrier).connect(makeInput(siteUrl)),
      service(barrier).connect(makeInput(siteUrl)),
    ]);
    const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
    const losers = attempts.filter((attempt) => attempt.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(losers[0]?.status === "rejected" && losers[0].reason instanceof WooConnectionConflictError);
    assert.equal(await database().shop.count({ where: { domain: siteUrl } }), 1);
    assert.equal(await database().wooCommerceInstallation.count({ where: { canonicalSiteUrl: siteUrl } }), 1);
  } finally {
    await removeSite(siteUrl);
  }
});

test("PostgreSQL concurrent reconnects use credential-version CAS so one returned credential wins", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  try {
    const initial = await service().connect(makeInput(siteUrl));
    const barrier = await twoPartyBarrier();
    const attempts = await Promise.allSettled([
      service(barrier).connect(makeInput(siteUrl)),
      service(barrier).connect(makeInput(siteUrl)),
    ]);
    const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
    const losers = attempts.filter((attempt) => attempt.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(losers[0]?.status === "rejected" && losers[0].reason instanceof WooConnectionConflictError);
    const winner = winners[0];
    assert.ok(winner?.status === "fulfilled");
    const installation = await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } });
    assert.equal(installation.credentialVersion, initial.credentialVersion + 1);
    assert.deepEqual(Buffer.from(installation.credentialDigest), digestSecret(Buffer.from(winner.value.credential, "base64url")));
  } finally {
    await removeSite(siteUrl);
  }
});

test("PostgreSQL suspended Shop reconnect is rejected without changing installation state", {
  skip: !databaseUrl,
}, async () => {
  const siteUrl = uniqueSite();
  try {
    const initial = await service().connect(makeInput(siteUrl));
    await database().shop.update({ where: { id: initial.shopId }, data: { status: "SUSPENDED" } });
    const before = await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } });
    await assert.rejects(service().connect(makeInput(siteUrl)), WooConnectionConflictError);
    const after = await database().wooCommerceInstallation.findUniqueOrThrow({ where: { id: initial.installationId } });
    assert.deepEqual(after, before);
  } finally {
    await removeSite(siteUrl);
  }
});

after(async () => {
  await prisma?.$disconnect();
});