import assert from "node:assert/strict";
import test from "node:test";
import { MerchantRecoveryDetailService } from "../../../../../src/merchant/recoveries/detail/read.service.js";
import { RecoveryDetailIntegrityError } from "../../../../../src/merchant/recoveries/detail/contracts.js";

const principal = {
  installationId: "inst_1", shopId: "shop_1",
  canonicalSiteUrl: "https://woo.example", credentialVersion: 3,
};
const at = new Date("2026-10-09T15:44:00.000Z");
const recovery = {
  id: "rec_1", shopId: principal.shopId, customerId: "customer_1", status: "COMPLETED",
  totalPrice: { toString: () => "89.99" }, currency: "GBP", detectedAt: at,
  messageSentAt: null, engagedAt: null, completedAt: at, expiredAt: null,
  customer: { shopId: principal.shopId, firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
  conversation: { id: "conv_1", shopId: principal.shopId, checkoutRecoveryId: "rec_1" },
};

function database(override: {
  shop?: Record<string, unknown> | null;
  installation?: Record<string, unknown> | null;
  recovery?: Record<string, unknown> | null;
} = {}) {
  const calls: unknown[] = [];
  const tx = {
    shop: { findUnique: async () => override.shop === undefined ? {
      id: principal.shopId, domain: principal.canonicalSiteUrl, platform: "WOOCOMMERCE",
      shopifyShopId: null, status: "ACTIVE", defaultTimeZone: "Europe/London",
    } : override.shop },
    wooCommerceInstallation: { findUnique: async () => override.installation === undefined ? {
      id: principal.installationId, shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
      status: "ACTIVE", revokedAt: null, credentialVersion: 3,
    } : override.installation },
    checkoutRecovery: { findFirst: async (arg: unknown) => {
      calls.push(arg);
      return override.recovery === undefined ? recovery : override.recovery;
    } },
  };
  const db = { $transaction: async (run: (transaction: typeof tx) => Promise<unknown>, options: unknown) => {
    calls.push(options);
    return run(tx);
  } };
  return { service: new MerchantRecoveryDetailService(db as never), calls };
}

test("summary reads existing recovery only through same-shop predicate and repeatable-read", async () => {
  const { service, calls } = database();
  const result = await service.summary(principal, "rec_1");
  assert.equal(result?.id, "rec_1");
  assert.equal(result?.timeZone, "Europe/London");
  assert.deepEqual(result?.customer, { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" });
  assert.deepEqual(result?.value, { amount: "89.99", currency: "GBP", incomplete: false });
  assert.equal(result?.milestones.completedAt, at.toISOString());
  assert.deepEqual(calls[0], { isolationLevel: "RepeatableRead" });
  assert.deepEqual((calls[1] as { where: unknown }).where, { id: "rec_1", shopId: "shop_1" });
});

test("missing and foreign resources return identical null; no customer email guessing", async () => {
  const { service } = database({ recovery: null });
  assert.equal(await service.summary(principal, "rec_1"), null);
  assert.equal(await service.summary(principal, "rec_9"), null);
  const noCustomer = database({ recovery: { ...recovery, customerId: null, customer: null, conversation: null } });
  assert.equal((await noCustomer.service.summary(principal, "rec_1"))?.customer, null);
  assert.deepEqual((await noCustomer.service.messages(principal, "rec_1", new URLSearchParams()))?.items, []);
  assert.deepEqual((await noCustomer.service.related(principal, "rec_1", new URLSearchParams()))?.items, []);
});

test("stale installation, foreign customer and foreign conversation fail closed", async () => {
  const stale = database({ installation: { id: "inst_1", shopId: "shop_1", canonicalSiteUrl: "https://woo.example",
    status: "ACTIVE", revokedAt: null, credentialVersion: 2 } });
  await assert.rejects(stale.service.summary(principal, "rec_1"), RecoveryDetailIntegrityError);
  const foreignCustomer = database({ recovery: { ...recovery, customer: { ...recovery.customer, shopId: "other" } } });
  await assert.rejects(foreignCustomer.service.summary(principal, "rec_1"), RecoveryDetailIntegrityError);
  const foreignConversation = database({ recovery: { ...recovery, conversation: {
    ...recovery.conversation, shopId: "other",
  } } });
  await assert.rejects(foreignConversation.service.summary(principal, "rec_1"), RecoveryDetailIntegrityError);
});
