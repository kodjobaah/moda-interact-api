import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma as PrismaTypes } from "@prisma/client";
import { requireCurrentWooMutationPrincipal, WooMutationPrincipalConflictError } from
  "../../../../src/auth/woo-installation/current-mutation-principal.js";

const principal = {
  installationId: "installation-1",
  shopId: "shop-1",
  canonicalSiteUrl: "https://merchant.example",
  credentialVersion: 4,
};

function transaction(overrides: {
  shop?: Record<string, unknown> | null;
  installation?: Record<string, unknown> | null;
  queryRaw?: (query: unknown) => Promise<Array<{ id: string }>>;
} = {}): PrismaTypes.TransactionClient {
  return {
    $queryRaw: overrides.queryRaw ?? (async () => [{ id: "locked" }]),
    shop: { findUnique: async () => overrides.shop ?? {
      id: "shop-1", domain: "https://merchant.example", platform: "WOOCOMMERCE",
      shopifyShopId: null, status: "ACTIVE", onboardingCompleted: true,
    } },
    wooCommerceInstallation: { findUnique: async () => overrides.installation ?? {
      id: "installation-1", shopId: "shop-1", canonicalSiteUrl: "https://merchant.example",
      credentialVersion: 4, status: "ACTIVE", revokedAt: null,
    } },
  } as unknown as PrismaTypes.TransactionClient;
}

test("locks Shop before installation and returns the transaction-local onboarding value", async () => {
  const statements: Array<{ sql: string }> = [];
  const result = await requireCurrentWooMutationPrincipal(transaction({
    queryRaw: async (query) => { statements.push(query as { sql: string }); return [{ id: "locked" }]; },
  }), principal);

  assert.match(statements[0]!.sql, /"commerce"\."Shop"[\s\S]*FOR UPDATE/);
  assert.match(statements[1]!.sql, /"woocommerce"\."WooCommerceInstallation"[\s\S]*FOR SHARE/);
  assert.deepEqual(result, {
    shopId: "shop-1", installationId: "installation-1", credentialVersion: 4,
    canonicalSiteUrl: "https://merchant.example", shopDomain: "https://merchant.example",
    onboardingCompleted: true,
  });
});

test("rejects stale lifecycle and principal bindings with one typed conflict", async () => {
  for (const overrides of [
    { shop: { id: "shop-1", domain: "https://merchant.example", platform: "WOOCOMMERCE",
      shopifyShopId: null, status: "SUSPENDED", onboardingCompleted: true } },
    { installation: { id: "installation-1", shopId: "shop-1", canonicalSiteUrl: "https://merchant.example",
      credentialVersion: 3, status: "ACTIVE", revokedAt: null } },
    { installation: { id: "installation-1", shopId: "shop-1", canonicalSiteUrl: "https://merchant.example",
      credentialVersion: 4, status: "ACTIVE", revokedAt: new Date() } },
  ]) {
    await assert.rejects(requireCurrentWooMutationPrincipal(transaction(overrides), principal),
      WooMutationPrincipalConflictError);
  }
});

test("propagates unexpected transaction read failures unchanged", async () => {
  const failure = new Error("database unavailable");
  const tx = transaction({
    queryRaw: async () => [{ id: "locked" }],
    shop: null,
  });
  (tx.shop as unknown as { findUnique: () => Promise<never> }).findUnique = async () => { throw failure; };
  await assert.rejects(requireCurrentWooMutationPrincipal(tx, principal), (error) => error === failure);
});