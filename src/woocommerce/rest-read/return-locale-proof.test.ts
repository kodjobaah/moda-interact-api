import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { MODA_SUPPORTED_LANGUAGE_TAGS } from "@modainteract/moda-interact-shared/internationalization";
import { preferredWooAdminLocale, signWooReturnLocale, verifyWooReturnLocale } from "./return-locale-proof.js";

const keyring = { activeKeyId: "v1", keys: new Map([["v1", Buffer.alloc(32, 7)]]) };

test("WordPress administrator locale resolves to each supported merchant language", () => {
  const examples = [
    ["de_DE", "de"], ["en_US", "en"], ["pt_BR", "pt-BR"], ["pt_PT", "pt-PT"],
    ["zh_CN", "zh-Hans"], ["zh_TW", "zh-Hant"], ["nb_NO", "nb"], ["ja", "ja"],
  ] as const;
  assert.equal(MODA_SUPPORTED_LANGUAGE_TAGS.length, 20);
  for (const [input, expected] of examples) assert.equal(preferredWooAdminLocale(input), expected);
  for (const locale of MODA_SUPPORTED_LANGUAGE_TAGS) {
    assert.equal(preferredWooAdminLocale(locale), locale);
  }
  for (const input of [undefined, "", "xx_YY", "pt_AO", "zh", "../fr", "fr\n", "a".repeat(65)]) {
    assert.equal(preferredWooAdminLocale(input), null, String(input));
  }
});

test("return preference is bound to the exact attempt and shop with server-held secret", () => {
  const proof = signWooReturnLocale(keyring, "attempt-a", "shop-one", "en");
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyWooReturnLocale(keyring, "attempt-a", "shop-one", "en", proof), "en");
  for (const [attempt, shop, locale, signature] of [
    ["attempt-b", "shop-one", "en", proof],
    ["attempt-a", "shop-two", "en", proof],
    ["attempt-a", "shop-one", "de", proof],
    ["attempt-a", "shop-one", "en", `${proof.slice(0, -1)}!`],
    ["attempt-a", "shop-one", "en", null],
    ["attempt-a", "shop-one", "xx", proof],
  ] as const) {
    assert.equal(verifyWooReturnLocale(keyring, attempt, shop, locale, signature), null);
  }
  const rotated = { activeKeyId: "v2", keys: new Map([...keyring.keys, ["v2", randomBytes(32)]]) };
  assert.equal(verifyWooReturnLocale(rotated, "attempt-a", "shop-one", "en", proof), "en");
  assert.equal(verifyWooReturnLocale({ keys: new Map([["v2", randomBytes(32)]]) },
    "attempt-a", "shop-one", "en", proof), null);
  assert.throws(() => signWooReturnLocale({ activeKeyId: "missing", keys: keyring.keys },
    "attempt-a", "shop-one", "en"), TypeError);
});
