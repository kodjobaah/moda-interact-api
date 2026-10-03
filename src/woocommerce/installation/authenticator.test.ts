import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { WooInstallationAuthenticator, WooUnauthenticatedError } from "./authenticator.js";
import { digestSecret } from "./credential.js";

const credential = Buffer.alloc(32, 4);
const credentialHeader = `Bearer ${credential.toString("base64url")}`;
const activeInstallation = {
  id: "install_123",
  shopId: "shop_authoritative",
  canonicalSiteUrl: "https://merchant.example",
  status: "ACTIVE",
  credentialDigest: digestSecret(credential),
  credentialVersion: 7,
  revokedAt: null,
  shop: { status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null },
};

function request(rawHeaders: string[]): IncomingMessage {
  return { rawHeaders } as unknown as IncomingMessage;
}

function makeAuthenticator(installation: unknown = activeInstallation) {
  const queries: unknown[] = [];
  const authenticator = new WooInstallationAuthenticator({
    wooCommerceInstallation: {
      findUnique: async (args: unknown) => {
        queries.push(args);
        return installation;
      },
    },
  } as never);
  return { authenticator, queries };
}

test("authentication derives the principal only from the active installation row", async () => {
  const { authenticator, queries } = makeAuthenticator();
  const principal = await authenticator.authenticate(request([
    "X-Moda-Installation-Id", "install_123",
    "Authorization", credentialHeader,
  ]));

  assert.deepEqual(principal, {
    installationId: "install_123",
    shopId: "shop_authoritative",
    canonicalSiteUrl: "https://merchant.example",
    credentialVersion: 7,
  });
  const query = queries[0] as { where: unknown; select: Record<string, unknown> };
  assert.deepEqual(query.where, { id: "install_123" });
  assert.equal(typeof query.select.shop, "object");
});

test("malformed, missing and duplicate authentication headers share the same failure", async () => {
  const { authenticator, queries } = makeAuthenticator();
  const requests = [
    request([]),
    request(["X-Moda-Installation-Id", "install_123"]),
    request(["X-Moda-Installation-Id", "install_123", "X-Moda-Installation-Id", "install_123", "Authorization", credentialHeader]),
    request(["X-Moda-Installation-Id", "install_123", "Authorization", "Bearer wrong"]),
  ];
  for (const incoming of requests) {
    await assert.rejects(authenticator.authenticate(incoming), (error: unknown) => {
      assert.ok(error instanceof WooUnauthenticatedError);
      assert.equal(error.message, "unauthorized");
      return true;
    });
  }
  assert.equal(queries.length, 0);
});

test("wrong secret, revoked installation and incompatible Shop share one failure", async () => {
  const incompatibleRows = [
    { ...activeInstallation, credentialDigest: digestSecret(Buffer.alloc(32, 5)) },
    { ...activeInstallation, revokedAt: new Date() },
    { ...activeInstallation, status: "REVOKED" },
    { ...activeInstallation, shop: { ...activeInstallation.shop, status: "SUSPENDED" } },
    { ...activeInstallation, shop: { ...activeInstallation.shop, platform: "SHOPIFY" } },
    { ...activeInstallation, shop: { ...activeInstallation.shop, shopifyShopId: "gid://shop" } },
  ];

  for (const installation of incompatibleRows) {
    const { authenticator } = makeAuthenticator(installation);
    await assert.rejects(
      authenticator.authenticate(request([
        "X-Moda-Installation-Id", "install_123",
        "Authorization", credentialHeader,
      ])),
      (error: unknown) => error instanceof WooUnauthenticatedError && error.message === "unauthorized",
    );
  }
});