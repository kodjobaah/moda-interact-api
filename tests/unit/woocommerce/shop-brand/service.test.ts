import assert from "node:assert/strict";
import test from "node:test";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { WooShopBrandService } from "../../../../src/woocommerce/shop-brand/service.js";
import type { WooShopBrandSnapshot } from "../../../../src/woocommerce/shop-brand/contract.js";

const principal = { shopId: "shop-1", installationId: "inst-1",
  canonicalSiteUrl: "https://woo.example", credentialVersion: 1 };
const clock = new Date("2026-10-27T12:00:00.000Z");
const snapshot = (time = "2026-10-27T11:58:00.000Z"): WooShopBrandSnapshot => ({
  schemaVersion: "woo.shop-brand.v1", eventId: "event-1", observedAt: time,
  brandName: "Woo shop", logo: { url: "https://woo.example/logo.png", attachmentId: 12,
    altText: "Logo", width: 1000, height: 400 }, siteIcon: null, coverImage: null,
});

type RawSql = { values?: unknown[]; v?: unknown[]; strings: readonly string[] };
function inMemoryTransaction() {
  let media: Record<string, unknown> = {};
  let brand: Record<string, unknown> | null = null;
  let writes = 0;
  let validInstallation = true;
  const db = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
      $queryRaw: async (query: RawSql) => {
        const sql = query.strings.join("?");
        if (sql.includes('FROM "commerce"."ShopBrand"')) return brand ? [{ ...brand, whatsAppMedia: media }] : [];
        if (sql.includes('FROM "commerce"."Shop"')) return [{ id: "shop-1", domain: principal.canonicalSiteUrl,
          status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null }];
        if (sql.includes('FROM "woocommerce"."WooCommerceInstallation"')) return validInstallation
          ? [{ id: "inst-1", shopId: "shop-1", canonicalSiteUrl: principal.canonicalSiteUrl,
            credentialVersion: 1, status: "ACTIVE", revokedAt: null }] : [];
        throw new Error("unexpected query");
      },
      shopBrand: { create: async () => { brand = { id: "brand-1", brandName: null, logoUrl: null,
        logoAltText: null, logoWidth: null, logoHeight: null,
        squareLogoUrl: null, squareLogoAltText: null, coverImageUrl: null }; } },
      $executeRaw: async (query: RawSql) => {
        const values = query.values ?? query.v ?? [];
        if (!brand || values.length !== 13) throw new Error("unexpected UPDATE");
        Object.assign(brand, { brandName: values[0], logoUrl: values[1], logoAltText: values[2],
          logoWidth: values[3], logoHeight: values[4], squareLogoUrl: values[5],
          squareLogoAltText: values[6], coverImageUrl: values[7] });
        media = JSON.parse(String(values[8])) as Record<string, unknown>;
        writes++;
        return 1;
      },
    }),
  };
  return { db, state: () => ({ media, brand, writes }), revoke: () => { validInstallation = false; } };
}

test("transactional source generations, idempotence and stale observations", async () => {
  const fake = inMemoryTransaction();
  const service = new WooShopBrandService(fake.db as never, () => clock);
  const first = snapshot();
  assert.deepEqual(await service.record(principal, first), { status: "updated" });
  assert.deepEqual(await service.record(principal, first), { status: "unchanged" });
  assert.deepEqual(await service.record(principal, { ...first, observedAt: "2026-10-27T11:57:00.000Z" }),
    { status: "unchanged" });
  await assert.rejects(service.record(principal, { ...first,
    logo: { ...first.logo!, url: "https://woo.example/conflict.png" } }),
    (err: unknown) => err instanceof Error && err.message === "invalid_request");
  assert.equal(fake.state().writes, 1);
  const roles = fake.state().media.roles as Record<string, { source: { generation: number }; work: { status: string } }>;
  assert.equal(roles.LOGO!.source.generation, 1);
  assert.equal(roles.SQUARE_LOGO!.work.status, "MISSING");
  const changed = { ...first, observedAt: "2026-10-27T11:59:00.000Z", logo: null };
  assert.deepEqual(await service.record(principal, changed), { status: "updated" });
  const next = fake.state().media.roles as typeof roles;
  assert.equal(next.LOGO!.source.generation, 2);
  assert.equal(next.LOGO!.work.status, "MISSING");
  assert.equal(next.SQUARE_LOGO!.source.generation, 1);
  assert.equal(fake.state().writes, 2);
  await assert.rejects(service.record(principal, { ...changed, observedAt: "2026-10-27T12:05:01.000Z" }),
    (err: unknown) => err instanceof Error && err.message === "invalid_request");
  fake.revoke();
  await assert.rejects(service.record(principal, { ...changed, observedAt: "2026-10-27T12:00:00.000Z" }),
    WooUnauthenticatedError);
  assert.equal(fake.state().writes, 2);
});
