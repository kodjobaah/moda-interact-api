import assert from "node:assert/strict";
import test from "node:test";
import { WooInstallationConnectionService, WooConnectionConflictError, WooSiteControlRejectedError } from "./connection-service.js";
import { digestSecret } from "./credential.js";
import { canonicalizeWooSiteUrl } from "./site-url.js";
import { SiteVerificationError } from "./site-verifier.js";

const site = canonicalizeWooSiteUrl("https://merchant.example/store", "public");
const attemptId = "550e8400-e29b-41d4-a716-446655440000";
const bootstrapSecret = Buffer.alloc(32, 3);
const credential = Buffer.alloc(32, 8);
const issuedAt = new Date("2026-10-03T12:00:00.000Z");

function makeDatabase(options: {
  observed?: unknown;
  shop?: unknown;
  createShopId?: string;
  createInstallationId?: string;
  updatedCount?: number;
  resultingVersion?: number;
} = {}) {
  const observed = options.observed ?? null;
  const shopState = options.shop ?? {
    id: "shop-1",
    status: "ACTIVE",
    platform: "WOOCOMMERCE",
    shopifyShopId: null,
  };
  const writes: Array<{ model: string; args: unknown }> = [];
  const transaction = {
    shop: {
      create: async (args: unknown) => {
        writes.push({ model: "shop.create", args });
        return { id: options.createShopId ?? "shop-created" };
      },
      findUnique: async () => shopState,
      updateMany: async (args: unknown) => {
        writes.push({ model: "shop.updateMany", args });
        return { count: 1 };
      },
    },
    wooCommerceInstallation: {
      create: async (args: unknown) => {
        writes.push({ model: "installation.create", args });
        return {
          id: options.createInstallationId ?? "installation-created",
          shopId: options.createShopId ?? "shop-created",
          credentialVersion: 1,
        };
      },
      updateMany: async (args: unknown) => {
        writes.push({ model: "installation.updateMany", args });
        return { count: options.updatedCount ?? 1 };
      },
      findUniqueOrThrow: async () => ({
        id: "installation-existing",
        shopId: "shop-1",
        credentialVersion: options.resultingVersion ?? 5,
      }),
    },
  };
  const database = {
    wooCommerceInstallation: {
      findUnique: async () => observed,
    },
    shop: {},
    $transaction: async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
  };
  return { database, writes };
}

function existingInstallation(status = "ACTIVE") {
  return {
    id: "installation-existing",
    shopId: "shop-1",
    credentialVersion: 4,
    shop: {
      id: "shop-1",
      status,
      platform: "WOOCOMMERCE",
      shopifyShopId: null,
    },
  };
}

test("first connection verifies site control before atomically creating Shop and installation", async () => {
  const { database, writes } = makeDatabase();
  const order: string[] = [];
  const verifier = { verify: async () => { order.push("verified"); } };
  const service = new WooInstallationConnectionService(
    database as never,
    verifier as never,
    () => issuedAt,
    () => credential,
  );

  const result = await service.connect({ site, attemptId, bootstrapSecret });

  assert.deepEqual(order, ["verified"]);
  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.model, "shop.create");
  assert.equal(writes[1]?.model, "installation.create");
  const shopData = (writes[0]?.args as { data: Record<string, unknown> }).data;
  const installationData = (writes[1]?.args as { data: Record<string, unknown> }).data;
  assert.deepEqual(shopData, {
    domain: site.canonicalSiteUrl,
    platform: "WOOCOMMERCE",
    shopifyShopId: null,
    status: "ACTIVE",
  });
  assert.deepEqual(Buffer.from(installationData.credentialDigest as Uint8Array), digestSecret(credential));
  assert.equal(installationData.credentialVersion, 1);
  assert.equal(JSON.stringify(writes).includes(credential.toString("base64url")), false);
  assert.deepEqual(result, {
    installationId: "installation-created",
    shopId: "shop-created",
    canonicalSiteUrl: site.canonicalSiteUrl,
    credential: credential.toString("base64url"),
    credentialVersion: 1,
    connection: "CREATED",
  });
});

test("failed challenge proof causes no durable write or credential issuance", async () => {
  const { database, writes } = makeDatabase();
  let issued = false;
  const service = new WooInstallationConnectionService(
    database as never,
    { verify: async () => { throw new SiteVerificationError("site_proof_rejected"); } } as never,
    () => issuedAt,
    () => { issued = true; return credential; },
  );

  await assert.rejects(
    service.connect({ site, attemptId, bootstrapSecret }),
    WooSiteControlRejectedError,
  );
  assert.equal(writes.length, 0);
  assert.equal(issued, false);
});

test("reconnect rotates only the credential with observed-version CAS and restores an uninstalled Shop", async () => {
  const { database, writes } = makeDatabase({
    observed: existingInstallation("UNINSTALLED"),
    shop: {
      id: "shop-1",
      status: "UNINSTALLED",
      platform: "WOOCOMMERCE",
      shopifyShopId: null,
    },
  });
  const service = new WooInstallationConnectionService(
    database as never,
    { verify: async () => undefined } as never,
    () => issuedAt,
    () => credential,
  );

  const result = await service.connect({ site, attemptId, bootstrapSecret });

  const update = writes.find((write) => write.model === "installation.updateMany");
  const args = update?.args as { where: Record<string, unknown>; data: Record<string, unknown> };
  assert.deepEqual(args.where, {
    id: "installation-existing",
    shopId: "shop-1",
    credentialVersion: 4,
  });
  assert.deepEqual({
    ...args.data,
    credentialDigest: Buffer.from(args.data.credentialDigest as Uint8Array),
  }, {
    credentialDigest: digestSecret(credential),
    credentialVersion: { increment: 1 },
    credentialIssuedAt: issuedAt,
    status: "ACTIVE",
    revokedAt: null,
  });
  assert.equal(writes.some((write) => write.model === "shop.create"), false);
  assert.equal(writes.some((write) => write.model === "shop.updateMany"), true);
  assert.equal(result.installationId, "installation-existing");
  assert.equal(result.shopId, "shop-1");
  assert.equal(result.credentialVersion, 5);
  assert.equal(result.connection, "RECONNECTED");
});

test("suspended Shop conflicts only after site proof; failed proof issues no credential or writes", async () => {
  const suspended = makeDatabase({
    observed: existingInstallation("SUSPENDED"),
    shop: {
      id: "shop-1",
      status: "SUSPENDED",
      platform: "WOOCOMMERCE",
      shopifyShopId: null,
    },
  });
  let verified = false;
  let issued = false;
  const suspendedService = new WooInstallationConnectionService(
    suspended.database as never,
    { verify: async () => { verified = true; } } as never,
    () => issuedAt,
    () => { issued = true; return credential; },
  );
  await assert.rejects(
    suspendedService.connect({ site, attemptId, bootstrapSecret }),
    WooConnectionConflictError,
  );
  assert.equal(verified, true);
  assert.equal(issued, true);
  assert.equal(suspended.writes.length, 0);

  const rejectedProof = makeDatabase({
    observed: existingInstallation("SUSPENDED"),
    shop: {
      id: "shop-1",
      status: "SUSPENDED",
      platform: "WOOCOMMERCE",
      shopifyShopId: null,
    },
  });
  let rejectedProofCredentialIssued = false;
  const rejectedProofService = new WooInstallationConnectionService(
    rejectedProof.database as never,
    { verify: async () => { throw new SiteVerificationError("site_proof_rejected"); } } as never,
    () => issuedAt,
    () => { rejectedProofCredentialIssued = true; return credential; },
  );
  await assert.rejects(
    rejectedProofService.connect({ site, attemptId, bootstrapSecret }),
    WooSiteControlRejectedError,
  );
  assert.equal(rejectedProof.writes.length, 0);
  assert.equal(rejectedProofCredentialIssued, false);

  const stale = makeDatabase({ observed: existingInstallation(), updatedCount: 0 });
  const staleService = new WooInstallationConnectionService(
    stale.database as never,
    { verify: async () => undefined } as never,
    () => issuedAt,
    () => credential,
  );
  await assert.rejects(
    staleService.connect({ site, attemptId, bootstrapSecret }),
    WooConnectionConflictError,
  );
});