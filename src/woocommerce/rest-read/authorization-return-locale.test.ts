import assert from "node:assert/strict";
import test from "node:test";
import { WooReadAuthorizationService } from "./authorization.service.js";
import { signWooReturnLocale } from "./return-locale-proof.js";

function serviceWithShop(storeLocale: string | null, defaultLanguageTag: string | null) {
  const calls: unknown[] = [];
  const service = new WooReadAuthorizationService({
    wooCommerceRestReadAttempt: {
      findUnique: async (args: unknown) => {
        calls.push(args);
        return {
          shopId: "shop-one",
          installation: {
            shopId: "shop-one",
            shop: { storeLocale, defaultLanguageTag },
          },
        };
      },
    },
  } as never, { keys: new Map([["v1", Buffer.alloc(32, 3)]]) } as never, "local-development", {} as never);
  return { service, calls };
}

test("browser return resolves the stored Woo shop locale using the canonical 20-language mapping", async () => {
  const examples: ReadonlyArray<readonly [string, string]> = [
    ["de_DE", "de"], ["en_US", "en"], ["pt_BR", "pt-BR"], ["pt_PT", "pt-PT"],
    ["zh_Hans_CN", "zh-Hans"], ["zh_Hant_TW", "zh-Hant"], ["fr_FR", "fr"],
    ["nb_NO", "nb"], ["ja", "ja"], ["zz_UNSUPPORTED", "en"],
  ];
  for (const [stored, expected] of examples) {
    const { service, calls } = serviceWithShop(stored, "it-IT");
    assert.equal(await service.returnLocale("opaque-attempt-id"), expected, stored ?? "missing");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      where: { id: "opaque-attempt-id" },
      select: {
        shopId: true,
        installation: { select: { shopId: true, shop: { select: { storeLocale: true, defaultLanguageTag: true } } } },
      },
    });
  }
});

test("browser return uses the persisted shop language tag when storeLocale is absent", async () => {
  const { service } = serviceWithShop(null, "tr-TR");
  assert.equal(await service.returnLocale("opaque-attempt-id"), "tr");
});

test("browser return falls back to English without querying when attempt id is invalid", async () => {
  const { service, calls } = serviceWithShop("de_DE", "de-DE");
  for (const id of [null, "", "../../credentials", "x".repeat(129)]) {
    assert.equal(await service.returnLocale(id), "en");
  }
  assert.deepEqual(calls, []);
});

test("browser return does not resolve language from an installation belonging to a different shop", async () => {
  const service = new WooReadAuthorizationService({
    wooCommerceRestReadAttempt: {
      findUnique: async () => ({
        shopId: "shop-one",
        installation: { shopId: "shop-two", shop: { storeLocale: "de_DE", defaultLanguageTag: "de-DE" } },
      }),
    },
  } as never, { keys: new Map([["v1", Buffer.alloc(32, 3)]]) } as never, "local-development", {} as never);
  assert.equal(await service.returnLocale("opaque-attempt-id"), "en");
});


test("valid administrator preference overrides shop language; tampering falls back to shop", async () => {
  const { service } = serviceWithShop("de_DE", "de-DE");
  const proof = signWooReturnLocale({ keys: new Map([["v1", Buffer.alloc(32, 3)]]), activeKeyId: "v1" },
    "opaque-attempt-id", "shop-one", "en");
  assert.equal(await service.returnLocale("opaque-attempt-id", "en", proof), "en");
  assert.equal(await service.returnLocale("opaque-attempt-id", "fr", proof), "de");
  assert.equal(await service.returnLocale("opaque-attempt-id", "en", "wrong-proof"), "de");
  assert.equal(await service.returnLocale("opaque-attempt-id", "en", null), "de");
});
