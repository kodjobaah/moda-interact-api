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
  const phases: string[] = [];
  const transactionOptions: unknown[] = [];
  const prepared = { catalogueId: "catalogue-free", operationalPlanId: "billing-free", shopifyPlanHandle: "free-handle" };
  const freeActivation = {
    prepare: async (_database: unknown, requireFirstGrantPolicy: boolean) => {
      phases.push(`prepared:${requireFirstGrantPolicy}`);
      return prepared;
    },
    activate: async (_transaction: unknown, shopId: string, resolved: unknown) => {
      writes.push({ model: "activation.activate", args: { shopId, resolved } });
      return "ACTIVATED_FREE" as const;
    },
  };
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
    wooCommerceInstallation: { findUnique: async () => observed },
    shop: {},
    $transaction: async (callback: (value: typeof transaction) => Promise<unknown>, options: unknown) => {
      transactionOptions.push(options);
      phases.push("transaction.started");
      return callback(transaction);
    },
  };
  return { database, writes, phases, freeActivation, transactionOptions };
}

function existingInstallation(status = "ACTIVE") {
  return {
    id: "installation-existing",
    shopId: "shop-1",
    credentialVersion: 4,
    shop: { id: "shop-1", status, platform: "WOOCOMMERCE", shopifyShopId: null, onboardingCompleted: true },
  };
}

test("first connection verifies site control before atomically creating Shop and installation", async () => {
  const { database, writes, phases, freeActivation, transactionOptions } = makeDatabase();
  const order: string[] = [];
  const service = new WooInstallationConnectionService(
    database as never,
    { verify: async () => { order.push("verified"); } } as never,
    () => issuedAt,
    () => credential,
    freeActivation,
  );

  const result = await service.connect({ site, attemptId, bootstrapSecret });

  assert.deepEqual(order, ["verified"]);
  assert.deepEqual(phases, ["prepared:true", "transaction.started"]);
  assert.deepEqual(transactionOptions, [{ isolationLevel: "Serializable", timeout: 15_000 }]);
  assert.deepEqual(writes.map((write) => write.model), ["shop.create", "activation.activate", "installation.create"]);
  assert.deepEqual((writes[1]?.args as { resolved: unknown }).resolved, {
    catalogueId: "catalogue-free", operationalPlanId: "billing-free", shopifyPlanHandle: "free-handle",
  });
  const shopData = (writes[0]?.args as { data: Record<string, unknown> }).data;
  const installationData = (writes[2]?.args as { data: Record<string, unknown> }).data;
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
  const { database, writes, freeActivation } = makeDatabase();
  let issued = false;
  const service = new WooInstallationConnectionService(
    database as never,
    { verify: async () => { throw new SiteVerificationError("site_proof_rejected"); } } as never,
    () => issuedAt,
    () => { issued = true; return credential; },
    freeActivation,
  );

  await assert.rejects(service.connect({ site, attemptId, bootstrapSecret }), WooSiteControlRejectedError);
  assert.equal(writes.length, 0);
  assert.equal(issued, false);
});

test("reconnect activates before credential CAS and restores an uninstalled Shop", async () => {
  const { database, writes, freeActivation } = makeDatabase({
    observed: existingInstallation("UNINSTALLED"),
    shop: { id: "shop-1", status: "UNINSTALLED", platform: "WOOCOMMERCE", shopifyShopId: null },
  });
  const service = new WooInstallationConnectionService(
    database as never,
    { verify: async () => undefined } as never,
    () => issuedAt,
    () => credential,
    freeActivation,
  );

  const result = await service.connect({ site, attemptId, bootstrapSecret });

  assert.ok(writes.findIndex((write) => write.model === "activation.activate") <
    writes.findIndex((write) => write.model === "installation.updateMany"));
  const update = writes.find((write) => write.model === "installation.updateMany");
  const args = update?.args as { where: Record<string, unknown>; data: Record<string, unknown> };
  assert.deepEqual(args.where, { id: "installation-existing", shopId: "shop-1", credentialVersion: 4 });
  assert.deepEqual({ ...args.data, credentialDigest: Buffer.from(args.data.credentialDigest as Uint8Array) }, {
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
    shop: { id: "shop-1", status: "SUSPENDED", platform: "WOOCOMMERCE", shopifyShopId: null },
  });
  let verified = false;
  let issued = false;
  const suspendedService = new WooInstallationConnectionService(
    suspended.database as never,
    { verify: async () => { verified = true; } } as never,
    () => issuedAt,
    () => { issued = true; return credential; },
    suspended.freeActivation,
  );
  await assert.rejects(suspendedService.connect({ site, attemptId, bootstrapSecret }), WooConnectionConflictError);
  assert.equal(verified, true);
  assert.equal(issued, true);
  assert.equal(suspended.writes.length, 0);

  const rejectedProof = makeDatabase({
    observed: existingInstallation("SUSPENDED"),
    shop: { id: "shop-1", status: "SUSPENDED", platform: "WOOCOMMERCE", shopifyShopId: null },
  });
  let rejectedProofCredentialIssued = false;
  const rejectedProofService = new WooInstallationConnectionService(
    rejectedProof.database as never,
    { verify: async () => { throw new SiteVerificationError("site_proof_rejected"); } } as never,
    () => issuedAt,
    () => { rejectedProofCredentialIssued = true; return credential; },
    rejectedProof.freeActivation,
  );
  await assert.rejects(rejectedProofService.connect({ site, attemptId, bootstrapSecret }), WooSiteControlRejectedError);
  assert.equal(rejectedProof.writes.length, 0);
  assert.equal(rejectedProofCredentialIssued, false);

  const stale = makeDatabase({ observed: existingInstallation(), updatedCount: 0 });
  const staleService = new WooInstallationConnectionService(
    stale.database as never,
    { verify: async () => undefined } as never,
    () => issuedAt,
    () => credential,
    stale.freeActivation,
  );
  await assert.rejects(staleService.connect({ site, attemptId, bootstrapSecret }), WooConnectionConflictError);
});
test("already-onboarded reconnect skips Free-plan preparation and rotates its credential", async () => {
  const { database, freeActivation, phases } = makeDatabase({ observed: existingInstallation() });
  const service = new WooInstallationConnectionService(
    database as never,
    { verify: async () => undefined } as never,
    () => issuedAt,
    () => credential,
    { ...freeActivation, prepare: async () => { throw new Error("must not prepare already onboarded Shop"); } },
  );
  const result = await service.connect({ site, attemptId, bootstrapSecret });
  assert.equal(result.connection, "RECONNECTED");
  assert.deepEqual(phases, ["transaction.started"]);
});

test("incomplete reconnect prepares global Free state before credential transaction", async () => {
  const incomplete = { ...existingInstallation(), shop: { ...existingInstallation().shop, onboardingCompleted: false } };
  const { database, phases, freeActivation } = makeDatabase({ observed: incomplete });
  const service = new WooInstallationConnectionService(
    database as never,
    { verify: async () => undefined } as never,
    () => issuedAt,
    () => credential,
    freeActivation,
  );
  assert.equal((await service.connect({ site, attemptId, bootstrapSecret })).connection, "RECONNECTED");
  assert.deepEqual(phases, ["prepared:false", "transaction.started"]);
});

test("failed Free-plan preflight does not start merchant transaction or mutate installation", async () => {
  const { database, freeActivation, writes, phases } = makeDatabase();
  const service = new WooInstallationConnectionService(
    database as never,
    { verify: async () => undefined } as never,
    () => issuedAt,
    () => credential,
    { ...freeActivation, prepare: async () => { throw new Error("preflight failed"); } },
  );
  await assert.rejects(service.connect({ site, attemptId, bootstrapSecret }), /preflight failed/);
  assert.deepEqual(phases, []);
  assert.deepEqual(writes, []);
});
