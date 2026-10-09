import assert from "node:assert/strict";
import test from "node:test";
import { isMerchantStoreContextSnapshot } from "./schema.js";

const snapshot = {
  schemaVersion: 1,
  storeLocale: "en_GB",
  languageTag: "en-GB",
  timeZone: "Europe/London",
  countryCode: "GB",
};

test("store-context contract accepts complete provider-native snapshots and independent nulls", () => {
  assert.equal(isMerchantStoreContextSnapshot(snapshot), true);
  assert.equal(isMerchantStoreContextSnapshot({ ...snapshot, storeLocale: "zh_Hant_TW" }), true);
  assert.equal(isMerchantStoreContextSnapshot({ ...snapshot, storeLocale: "sr_RS@latin" }), true);
  assert.equal(isMerchantStoreContextSnapshot({ ...snapshot, storeLocale: "custom_LOCALE" }), true);
  assert.equal(isMerchantStoreContextSnapshot({ ...snapshot, timeZone: "UTC" }), true);
  for (const key of ["storeLocale", "languageTag", "timeZone", "countryCode"]) {
    assert.equal(isMerchantStoreContextSnapshot({ ...snapshot, [key]: null }), true, key);
  }
  assert.equal(isMerchantStoreContextSnapshot({ ...snapshot, storeLocale: null, languageTag: null, timeZone: null, countryCode: null }), true);
});

test("store-context contract rejects any missing, additional, malformed or oversized value", () => {
  for (const value of [null, [], "text", 5, {}, { ...snapshot, schemaVersion: 2 },
    { ...snapshot, shopId: "attacker" }, { ...snapshot, siteUrl: "https://other.example" }]) {
    assert.equal(isMerchantStoreContextSnapshot(value), false);
  }
  for (const key of Object.keys(snapshot)) {
    const without = { ...snapshot } as Record<string, unknown>;
    delete without[key];
    assert.equal(isMerchantStoreContextSnapshot(without), false, key);
  }
  for (const value of ["", " ", "en\nGB", "en\u0000GB", "<script>", "é_US", "a".repeat(129)]) {
    assert.equal(isMerchantStoreContextSnapshot({ ...snapshot, storeLocale: value }), false, `storeLocale=${JSON.stringify(value)}`);
  }
  for (const value of ["", "en_GB", "en--GB", "EN GB", "x".repeat(65), 42]) {
    assert.equal(isMerchantStoreContextSnapshot({ ...snapshot, languageTag: value }), false);
  }
  for (const value of ["", "+01:00", "-05:30", "UTC+02:00", "GMT-2", "Mars/Base", "Europe/DoesNotExist", "Europe/London\n", "x".repeat(256)]) {
    assert.equal(isMerchantStoreContextSnapshot({ ...snapshot, timeZone: value }), false);
  }
  for (const value of ["", "gb", "GBR", "G1", " G", "ZZZ", 1]) {
    assert.equal(isMerchantStoreContextSnapshot({ ...snapshot, countryCode: value }), false);
  }
});
