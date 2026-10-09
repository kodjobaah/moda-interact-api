import assert from "node:assert/strict";
import test from "node:test";
import { MerchantStoreContextConflictError, MerchantStoreContextService } from "./store-context.service.js";
import type { MerchantStoreContextSnapshot } from "./schema.js";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";

const principal: WooInstallationPrincipal = {
  installationId: "installation_1", shopId: "shop_1", canonicalSiteUrl: "https://woo.example", credentialVersion: 3,
};
const snapshot: MerchantStoreContextSnapshot = {
  schemaVersion: 1, storeLocale: "pt_BR", languageTag: "pt-BR", timeZone: "America/Sao_Paulo", countryCode: "BR",
};

test("scopes one atomic Shop update to the authenticated installation and four context columns", async () => {
  const operations: unknown[] = [];
  const service = new MerchantStoreContextService({ shop: {
    updateMany: async (operation: unknown) => { operations.push(operation); return { count: 1 }; },
  } } as never);
  await service.update(principal, snapshot);
  await service.update(principal, snapshot);
  assert.equal(operations.length, 2);
  const operation = operations[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
  assert.deepEqual(operation.where, {
    id: "shop_1", domain: "https://woo.example", status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null,
    wooCommerceInstallation: { is: {
      id: "installation_1", shopId: "shop_1", canonicalSiteUrl: "https://woo.example",
      credentialVersion: 3, status: "ACTIVE", revokedAt: null,
    } },
  });
  assert.deepEqual(operation.data, {
    storeLocale: "pt_BR", defaultLanguageTag: "pt-BR", defaultTimeZone: "America/Sao_Paulo", defaultCountryCode: "BR",
  });
  assert.deepEqual(operations[1], operations[0]);
});

test("explicit null clears every existing field and no other mutation method is invoked", async () => {
  let calls = 0;
  const service = new MerchantStoreContextService({ shop: {
    updateMany: async ({ data }: { data: unknown }) => {
      calls++;
      assert.deepEqual(data, {
        storeLocale: null, defaultLanguageTag: null, defaultTimeZone: null, defaultCountryCode: null,
      });
      return { count: 1 };
    },
  } } as never);
  await service.update(principal, { schemaVersion: 1, storeLocale: null, languageTag: null, timeZone: null, countryCode: null });
  assert.equal(calls, 1);
});

test("stale, revoked, missing or inconsistent installation/Shop results in a conflict", async () => {
  const service = new MerchantStoreContextService({ shop: {
    updateMany: async () => ({ count: 0 }),
  } } as never);
  await assert.rejects(() => service.update(principal, snapshot), MerchantStoreContextConflictError);
});

test("unexpected database errors are left to the bounded HTTP failure handler", async () => {
  const service = new MerchantStoreContextService({ shop: {
    updateMany: async () => { throw new Error("database-secret"); },
  } } as never);
  await assert.rejects(() => service.update(principal, snapshot), /database-secret/);
});
