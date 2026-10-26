import assert from "node:assert/strict";
import test from "node:test";
import { allowedFollowUpChoice, choicesFromRows, validFollowUpRow,
  PROVIDER_APPROVAL_MAX_AGE_MS, type FollowUpRow } from "../../../../../src/merchant/conversations/messages/follow-up-catalogue.js";

const now = new Date("2026-10-26T09:00:00.000Z");
const shop = "woo-shop-one", waba = "123456789000";
function approved(overrides: Partial<FollowUpRow> = {}): FollowUpRow {
  return { variantId: "v1", shopId: shop, providerAccountId: waba,
    purpose: "FOLLOW_UP_NO_OFFER", languageTag: "en", name: "moda_follow_up", language: "en",
    variantProviderId: "meta-id", registrationId: "reg1", registrationWaba: waba,
    registrationName: "moda_follow_up", registrationLanguage: "en", registrationProviderId: "meta-id",
    category: "MARKETING", providerStatus: "APPROVED", submissionState: "CONFIRMED",
    failureCode: null, lastReconciledAt: new Date(now.getTime() - 1_000), driftDetectedAt: null,
    submittedHash: "a".repeat(64), observedHash: "a".repeat(64), observedCategory: "MARKETING",
    localeTag: "en", localeLanguage: "en", localeStatus: "REVIEWED",
    definitionKind: "META_RECOVERY", definitionPurpose: "FOLLOW_UP", definitionOffer: "NO_OFFER",
    definitionStatus: "PUBLISHED", definitionName: "moda_follow_up", definitionCategory: "MARKETING",
    publishedAt: new Date(now.getTime() - 100_000), retiredAt: null,
    ...overrides };
}
test("approved registered, published NO_OFFER projected to minimal wire choice", () => {
  assert.equal(validFollowUpRow(approved(), shop, waba, now), true);
  assert.deepEqual(choicesFromRows([approved()], shop, waba, now), [{ name: "moda_follow_up", language: "en" }]);
  assert.equal(allowedFollowUpChoice(choicesFromRows([approved()], shop, waba, now), "moda_follow_up", "en"), true);
  assert.equal(allowedFollowUpChoice(choicesFromRows([approved()], shop, waba, now), "moda_follow_up", "fr"), false);
});
test("provider, definition, identity and freshness failures suppress unsafe choices", () => {
  const bad: Partial<FollowUpRow>[] = [
    { registrationId: null }, { registrationWaba: "other" }, { providerAccountId: "other" },
    { registrationName: "fake" }, { registrationLanguage: "de" },
    { registrationProviderId: "other-id" }, { variantProviderId: null },
    { providerStatus: "REJECTED" }, { providerStatus: "UNKNOWN" }, { providerStatus: "PAUSED" },
    { submissionState: "READY_TO_SUBMIT" }, { failureCode: "RECONCILE_ERROR" },
    { driftDetectedAt: now }, { observedHash: "b".repeat(64) }, { observedCategory: "UTILITY" },
    { lastReconciledAt: null },
    { lastReconciledAt: new Date(now.getTime() - PROVIDER_APPROVAL_MAX_AGE_MS - 1) },
    { lastReconciledAt: new Date(now.getTime() + 1) },
    { localeStatus: "PENDING" }, { localeTag: "de" }, { localeLanguage: "de" },
    { definitionKind: "EXTERNAL" }, { definitionPurpose: "INITIAL" },
    { definitionOffer: "CODE_OFFER" }, { definitionStatus: "DRAFT" },
    { publishedAt: null }, { retiredAt: now }, { definitionCategory: "UTILITY" },
    { definitionName: "other" }, { name: "Invalid Name" }, { language: "fr-FR" },
    { submittedHash: "invalid" },
  ];
  for (const change of bad) {
    assert.deepEqual(choicesFromRows([approved(change)], shop, waba, now), [], JSON.stringify(change));
  }
});
test("ambiguous slots and visible name collisions fail closed, as do unverified positive offers", () => {
  const variant = approved();
  assert.deepEqual(choicesFromRows([variant, approved({ variantId: "v2" })], shop, waba, now), []);
  assert.deepEqual(choicesFromRows([variant, approved({ variantId: "v2", languageTag: "fr",
    localeTag: "fr", language: "en", localeLanguage: "en", registrationLanguage: "en" })], shop, waba, now), []);
  assert.deepEqual(choicesFromRows([approved({ purpose: "FOLLOW_UP_CODE_OFFER", definitionOffer: "CODE_OFFER" })], shop, waba, now), []);
  assert.deepEqual(choicesFromRows([approved({ purpose: "FOLLOW_UP_AUTOMATIC_OFFER", definitionOffer: "AUTOMATIC_OFFER" })], shop, waba, now), []);
  assert.deepEqual(choicesFromRows(Array(301).fill(variant), shop, waba, now), []);
});
test("multiple valid supported language choices return ordered safe strings", () => {
  const fr = approved({ variantId: "vfr", languageTag: "fr", localeTag: "fr", language: "fr",
    localeLanguage: "fr", registrationLanguage: "fr", registrationId: "rfr",
    name: "moda_follow_up_fr", registrationName: "moda_follow_up_fr", definitionName: "moda_follow_up_fr" });
  assert.deepEqual(choicesFromRows([fr, approved()], shop, waba, now), [
    { name: "moda_follow_up", language: "en" },
    { name: "moda_follow_up_fr", language: "fr" },
  ]);
});
