import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { digestSecret } from "../installation/credential.js";
import { WooReadAuthorizationService } from "./authorization.service.js";
import { WooReadCredentialVerifier } from "./credential-verifier.js";
import { loadWooRestReadAuthorizationConfig } from "./config.js";
import { WooProductReadService } from "./provider-connection.service.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const config = loadWooRestReadAuthorizationConfig({
  MODA_WOO_REST_READ_PUBLIC_ORIGIN: "http://localhost:3100",
  MODA_WOO_REST_READ_ACTIVE_KEY_ID: "test-grant",
  MODA_WOO_REST_READ_KEYRING: JSON.stringify({ "test-grant": Buffer.alloc(32, 17).toString("base64url") }),
}, "local-development");
assert.ok(config);
const logger = { info: () => undefined, warn: () => undefined };

async function withStore(callback: (input: {
  prisma: PrismaClient;
  shopId: string;
  installationId: string;
  credential: { consumerKey: string; consumerSecret: string };
  grant: WooReadAuthorizationService;
  read: WooProductReadService;
}) => Promise<void>): Promise<void> {
  if (!databaseUrl) throw new Error("disposable database fixture URL missing");
  const credential = { consumerKey: `ck_${randomUUID()}`, consumerSecret: `cs_${randomUUID()}` };
  const expectedAuthorization = `Basic ${Buffer.from(`${credential.consumerKey}:${credential.consumerSecret}`).toString("base64")}`;
  const fixture = createServer((req, res) => {
    if (req.method !== "GET" || req.headers.authorization !== expectedAuthorization ||
      !req.url?.startsWith("/wp-json/wc/v3/products")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "woocommerce_rest_cannot_view" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    const product = { id: 81, name: "Fixture Product", sku: "P81", price: "15", stock_status: "instock", stock_quantity: 5 };
    res.end(JSON.stringify(req.url.startsWith("/wp-json/wc/v3/products/81?") ? product : [product]));
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const address = fixture.address();
  assert.ok(address && typeof address === "object");
  const site = `http://localhost:${address.port}`;
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let shopId: string | undefined;
  try {
    const shop = await prisma.shop.create({ data: {
      domain: site, platform: "WOOCOMMERCE", status: "ACTIVE", shopifyShopId: null,
    } });
    shopId = shop.id;
    const installation = await prisma.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: site, credentialDigest: Uint8Array.from(digestSecret(Buffer.alloc(32, 5))),
      status: "ACTIVE", credentialVersion: 1, credentialIssuedAt: new Date(),
    } });
    const transport = new WooReadCredentialVerifier({
      mode: "local-development", resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const grant = new WooReadAuthorizationService(prisma, config!, "local-development", { verify: async () => undefined });
    const read = new WooProductReadService(prisma, config!, "local-development", transport, logger);
    await callback({ prisma, shopId: shop.id, installationId: installation.id, credential, grant, read });
  } finally {
    if (shopId) await prisma.shop.delete({ where: { id: shopId } });
    await prisma.$disconnect();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}

test("PostgreSQL real grant -> bounded Woo GET; revoke and stale generation fail closed", { skip: !databaseUrl }, async () => {
  await withStore(async ({ prisma, shopId, installationId, credential, grant, read }) => {
    const principal = { shopId, installationId, credentialVersion: 1, canonicalSiteUrl: "unused-by-test" };
    // The persisted installation, rather than principal fields, determines the outbound destination.
    const installed = await prisma.wooCommerceInstallation.findUniqueOrThrow({ where: { id: installationId } });
    principal.canonicalSiteUrl = installed.canonicalSiteUrl;
    const consent = new URL((await grant.start(principal)).authorizationUrl);
    const attemptId = consent.searchParams.get("user_id");
    const token = new URL(consent.searchParams.get("callback_url") ?? "").pathname.split("/").at(-1);
    assert.ok(attemptId && token);
    await grant.callback(token, {
      key_id: 88, user_id: attemptId, consumer_key: credential.consumerKey,
      consumer_secret: credential.consumerSecret, key_permissions: "read",
    });
    const selected = await prisma.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId } });
    assert.equal(selected.status, "ACTIVE");
    assert.equal(selected.authorizedScope, "read");
    assert.equal(Buffer.from(selected.credentialCiphertext).includes(Buffer.from(credential.consumerSecret)), false);
    assert.deepEqual(await read.read(shopId, { operation: "products.list", perPage: 1 }), {
      ok: true, operation: "products.list", products: [
        { id: 81, name: "Fixture Product", sku: "P81", price: "15", stockStatus: "instock", stockQuantity: 5 },
      ],
    });
    assert.equal((await read.read(shopId, { operation: "products.retrieve", productId: 81 })).ok, true);
    await grant.revoke(principal);
    assert.deepEqual(await read.read(shopId, { operation: "products.list" }), {
      ok: false, operation: "products.list", reason: "reauthorization_required",
    });
    const revised = await prisma.wooCommerceRestReadGrant.findUniqueOrThrow({ where: { installationId } });
    assert.equal(revised.status, "REVOKED");
    assert.equal((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).status, "ACTIVE");
    assert.equal((await prisma.wooCommerceInstallation.findUniqueOrThrow({ where: { id: installationId } })).credentialVersion, 1);
  });
});
