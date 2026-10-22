import assert from "node:assert/strict";
import test from "node:test";
import {
  PromotionRequestError, isPromotionReadResponse, isPromotionSelectionResponse, parsePromotionSelection,
} from "../../../../src/merchant/promotions/contract.js";
import { readPromotionsQuery } from "../../../../src/merchant/promotions/request.js";
import {
  isPromotionTargetEligible, promotionHistoryStatus, remainingPromotionCredits, translatedPromotion,
} from "../../../../src/merchant/promotions/projection.js";

import { read, selection, revision, iso } from "./fixtures.js";

test("request parsing is strict and revisions are bounded", () => {
  assert.deepEqual(parsePromotionSelection({ campaignId: "woo_123", expectedRevision: revision }),
    { campaignId: "woo_123", expectedRevision: revision });
  for (const value of [{ campaignId: "woo", expectedRevision: "abc" },
    { campaignId: "woo", expectedRevision: revision, shopId: "foreign" },
    { campaignId: "/etc/passwd", expectedRevision: revision }, [], null]) {
    assert.throws(() => parsePromotionSelection(value), PromotionRequestError);
  }
  assert.deepEqual(readPromotionsQuery(new URLSearchParams("offerPage=6&historyPage=10&locale=fr-FR")),
    { offerPage: 6, historyPage: 10, locale: "fr" });
  assert.equal(readPromotionsQuery(new URLSearchParams("locale=zz-ZZ")).locale, "en");
  for (const query of ["offerPage=0", "historyPage=1001", "offerPage=1&offerPage=2", "shopId=foo",
    "locale=%00", "locale=", "historyPage=2.5"]) {
    assert.throws(() => readPromotionsQuery(new URLSearchParams(query)), PromotionRequestError, query);
  }
});

test("output validator rejects forged extra fields, negative credits and invented history statuses", () => {
  assert.equal(isPromotionReadResponse(read), true);
  assert.equal(isPromotionSelectionResponse({ schemaVersion: 1, revision, selection }), true);
  assert.equal(isPromotionReadResponse({ ...read, shopId: "foreign" }), false);
  assert.equal(isPromotionReadResponse({ ...read, offers: [{ ...read.offers[0], privateToken: "secret" }] }), false);
  assert.equal(isPromotionReadResponse({ ...read, selection: { ...selection, remainingQuantity: -1 } }), false);
  assert.equal(isPromotionReadResponse({ ...read, history: { ...read.history,
    entries: [{ ...read.history.entries[0], status: "AVAILABLE" }] } }), false);
  assert.equal(isPromotionSelectionResponse({ schemaVersion: 1, revision, selection, internalId: "secret" }), false);
});

test("billing projection matches Shopify scope, usage and lifecycle semantics", () => {
  assert.equal(isPromotionTargetEligible({ scope: "PLAN", targetPlanId: "p", targetShopId: null }, "s", "p"), true);
  assert.equal(isPromotionTargetEligible({ scope: "SHOP", targetPlanId: null, targetShopId: "foreign" }, "s", "p"), false);
  assert.equal(isPromotionTargetEligible({ scope: "GLOBAL", targetPlanId: "foreign", targetShopId: null }, "s", "p"), false);
  assert.equal(remainingPromotionCredits({ quantity: 9, committedQuantity: 4, reservedQuantity: 3, exhaustedAt: null }), 2);
  assert.throws(() => remainingPromotionCredits({ quantity: 9, committedQuantity: 8, reservedQuantity: 3, exhaustedAt: null }));
  assert.equal(translatedPromotion([{ locale: "fr", merchantTitle: "Français" },
    { locale: "en", merchantTitle: "English" }], "de")?.merchantTitle, "English");
  const now = new Date("2026-10-01T00:00:00.000Z");
  const grant = { firstSelectedAt: new Date("2026-08-01T00:00:00.000Z"), firstUsedAt: now, exhaustedAt: null };
  const campaign = { scope: "GLOBAL", targetPlanId: null, targetShopId: null, status: "ACTIVE", expiresAt: new Date(iso) };
  assert.equal(promotionHistoryStatus(grant, campaign, "s", "p", null, 2, now), "USED");
  assert.equal(promotionHistoryStatus(grant, campaign, "s", "p", new Date("2026-09-01T00:00:00.000Z"), 2, now), "REOPENED");
  assert.equal(promotionHistoryStatus({ ...grant, exhaustedAt: now }, campaign, "s", "p", null, 0, now), "EXHAUSTED");
  assert.equal(promotionHistoryStatus(grant, { ...campaign, status: "CLOSED" }, "s", "p", null, 2, now), "CLOSED");
  assert.equal(promotionHistoryStatus(grant, { ...campaign, expiresAt: now }, "s", "p", null, 2, now), "EXPIRED");
  assert.equal(promotionHistoryStatus(grant, { ...campaign, scope: "SHOP", targetShopId: "foreign" },
    "s", "p", null, 2, now), "NO_LONGER_ELIGIBLE");
});
