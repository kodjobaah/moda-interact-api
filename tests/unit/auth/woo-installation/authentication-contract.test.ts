import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import {
  WooInstallationAuthenticator,
  WooUnauthenticatedError,
} from "../../../../src/auth/woo-installation/authenticator.js";
import { digestSecret } from "../../../../src/auth/woo-installation/credential.js";

const firstCredential = Buffer.alloc(32, 18);
const rotatedCredential = Buffer.alloc(32, 23);
const firstBearer = `Bearer ${firstCredential.toString("base64url")}`;
const rotatedBearer = `Bearer ${rotatedCredential.toString("base64url")}`;
const active = {
  id: "installation-known",
  shopId: "authoritative-shop",
  canonicalSiteUrl: "https://store.example",
  credentialVersion: 5,
  credentialDigest: digestSecret(firstCredential),
  status: "ACTIVE",
  revokedAt: null,
  shop: { status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null },
};

function request(headers: string[], normalized: Record<string, string> = {}): IncomingMessage {
  return { rawHeaders: headers, headers: normalized } as unknown as IncomingMessage;
}

function harness(current: () => unknown) {
  const queries: unknown[] = [];
  const authenticator = new WooInstallationAuthenticator({
    wooCommerceInstallation: {
      findUnique: async (options: unknown) => {
        queries.push(options);
        return current();
      },
    },
  } as never);
  return { authenticator, queries };
}

function credentialHeaders(bearer = firstBearer): string[] {
  return ["X-Moda-Installation-Id", "installation-known", "Authorization", bearer];
}

async function assertDenied(authenticator: WooInstallationAuthenticator, rawHeaders: string[]): Promise<void> {
  await assert.rejects(authenticator.authenticate(request(rawHeaders)), (error: unknown) =>
    error instanceof WooUnauthenticatedError && error.message === "unauthorized");
}

test("credentials come from exactly one raw header, never from a normalized caller-selected fallback", async () => {
  const { authenticator, queries } = harness(() => active);
  const malformed = [
    [],
    ["Authorization", firstBearer],
    ["X-Moda-Installation-Id", "installation-known"],
    ["X-Moda-Installation-Id", "installation-known", "X-Moda-Installation-Id", "installation-known", "Authorization", firstBearer],
    [...credentialHeaders(), "Authorization", firstBearer],
    credentialHeaders(`Bearer ${firstCredential.toString("base64url")}, Bearer ${firstCredential.toString("base64url")}`),
    credentialHeaders(`bearer ${firstCredential.toString("base64url")}`),
    credentialHeaders("Bearer invalid"),
  ];
  for (const rawHeaders of malformed) await assertDenied(authenticator, rawHeaders);
  await assert.rejects(authenticator.authenticate(request([], {
    "x-moda-installation-id": "installation-known",
    authorization: firstBearer,
  })), WooUnauthenticatedError);
  assert.equal(queries.length, 0, "malformed credentials must not query the database");
});

test("principal is database-derived and wrong secret, revoked and inactive rows fail closed", async () => {
  const cases = [
    null,
    { ...active, shopId: "another-shop", credentialDigest: digestSecret(rotatedCredential) },
    { ...active, status: "REVOKED" },
    { ...active, revokedAt: new Date("2026-10-01T00:00:00Z") },
    { ...active, shop: { ...active.shop, status: "SUSPENDED" } },
    { ...active, shop: { ...active.shop, platform: "SHOPIFY" } },
    { ...active, shop: { ...active.shop, shopifyShopId: "legacy-shopify" } },
  ];
  for (const current of cases) {
    const { authenticator } = harness(() => current);
    await assertDenied(authenticator, credentialHeaders());
  }
  const { authenticator, queries } = harness(() => active);
  const principal = await authenticator.authenticate(request(credentialHeaders(), {
    "x-moda-shop-id": "attacker-chosen-shop",
  }));
  assert.deepEqual(principal, {
    installationId: "installation-known",
    shopId: "authoritative-shop",
    canonicalSiteUrl: "https://store.example",
    credentialVersion: 5,
  });
  assert.deepEqual((queries[0] as { where: unknown }).where, { id: "installation-known" });
});

test("subsequent requests after credential rotation accept only the current digest and expose current version", async () => {
  let current = active;
  const { authenticator } = harness(() => current);
  assert.equal((await authenticator.authenticate(request(credentialHeaders()))).credentialVersion, 5);

  current = { ...active, credentialVersion: 6, credentialDigest: digestSecret(rotatedCredential) };
  await assertDenied(authenticator, credentialHeaders());
  assert.deepEqual(await authenticator.authenticate(request(credentialHeaders(rotatedBearer))), {
    installationId: "installation-known",
    shopId: "authoritative-shop",
    canonicalSiteUrl: "https://store.example",
    credentialVersion: 6,
  });
  // This test intentionally does not define policy for a command already in flight.
});
