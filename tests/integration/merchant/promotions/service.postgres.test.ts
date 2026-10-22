import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { PromotionDomainError } from "../../../../src/merchant/promotions/contract.js";
import { MerchantPromotionsService } from "../../../../src/merchant/promotions/service.js";

const url = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
const now = new Date("2026-10-22T12:00:00.000Z");
const future = new Date("2026-12-31T12:00:00.000Z");
const past = new Date("2026-10-01T12:00:00.000Z");

/** Only the disposable pgvector/PostgreSQL runner sets this URL. */
test("Woo promotions: grants, eligibility, CAS/races, history, auth, revocation and tenant isolation", { skip: !url }, async () => {
  if (!url) return;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const competitorDb = new PrismaClient({ datasources: { db: { url } } });
  const suffix = randomUUID();
  const shopIds: [string, string] = [`arch035-promo-a-${suffix}`, `arch035-promo-b-${suffix}`];
  const campaignIds: string[] = [];
  const planIds: string[] = [];
  let adminId: string | undefined;
  const service = new MerchantPromotionsService(db, () => now);
  const competingService = new MerchantPromotionsService(competitorDb, () => now);
  try {
    const admin = await db.platformAdmin.create({ data: { email: `arch035-promo-${suffix}@test.invalid` } });
    adminId = admin.id;
    const [plan, foreignPlan] = await Promise.all([
      db.billingPlan.create({ data: { shopifyPlanHandle: `promotion-a-${suffix}`, name: "Woo A", kind: "FREE" } }),
      db.billingPlan.create({ data: { shopifyPlanHandle: `promotion-b-${suffix}`, name: "Woo B", kind: "FREE" } }),
    ]);
    planIds.push(plan.id, foreignPlan.id);
    const [shop, other] = await Promise.all([
      db.shop.create({ data: { id: shopIds[0], domain: `https://promo-a-${suffix}.invalid`, platform: "WOOCOMMERCE" } }),
      db.shop.create({ data: { id: shopIds[1], domain: `https://promo-b-${suffix}.invalid`, platform: "WOOCOMMERCE" } }),
    ]);
    await db.subscription.createMany({ data: [
      { shopId: shop.id, status: "ACTIVE", planId: plan.id },
      { shopId: other.id, status: "ACTIVE", planId: foreignPlan.id },
    ] });
    const installation = await db.wooCommerceInstallation.create({ data: {
      shopId: shop.id, canonicalSiteUrl: shop.domain, credentialDigest: Buffer.alloc(32),
    } });
    const otherInstallation = await db.wooCommerceInstallation.create({ data: {
      shopId: other.id, canonicalSiteUrl: other.domain, credentialDigest: Buffer.alloc(32),
    } });
    const principal: WooInstallationPrincipal = {
      shopId: shop.id, canonicalSiteUrl: shop.domain, installationId: installation.id,
      credentialVersion: installation.credentialVersion,
    };
    const otherPrincipal: WooInstallationPrincipal = {
      shopId: other.id, canonicalSiteUrl: other.domain, installationId: otherInstallation.id,
      credentialVersion: otherInstallation.credentialVersion,
    };
    async function campaign(title: string, overrides: Partial<Prisma.PromotionCampaignUncheckedCreateInput> = {}) {
      const row = await db.promotionCampaign.create({ data: {
        name: title, merchantDescription: `${title} fallback`, scope: "GLOBAL", quantity: 9,
        startsAt: past, expiresAt: future, status: "ACTIVE", createdByPlatformAdminId: admin.id,
        ...overrides,
      } });
      campaignIds.push(row.id);
      return row;
    }
    const [global, planOffer, shopOffer, otherPlanOffer, otherShopOffer, expired, closed, exhausted] = await Promise.all([
      campaign("Global"),
      campaign("Plan", { scope: "PLAN", targetPlanId: plan.id }),
      campaign("Shop", { scope: "SHOP", targetShopId: shop.id }),
      campaign("Other plan", { scope: "PLAN", targetPlanId: foreignPlan.id }),
      campaign("Other shop", { scope: "SHOP", targetShopId: other.id }),
      campaign("Expired", { expiresAt: past, startsAt: new Date("2026-09-01T00:00:00.000Z") }),
      campaign("Closed", { status: "CLOSED" }),
      campaign("Exhausted", { quantity: 4 }),
    ]);
    await db.promotionCampaignTranslation.createMany({ data: [
      { promotionCampaignId: global.id, locale: "en", merchantTitle: "English title", merchantDescription: "English body" },
      { promotionCampaignId: global.id, locale: "fr", merchantTitle: "Titre français", merchantDescription: "Description française" },
    ] });
    await db.promotionalCreditGrant.createMany({ data: [
      { shopId: shop.id, campaignId: expired.id, quantity: 9, firstSelectedAt: past, lastSelectedAt: past },
      { shopId: shop.id, campaignId: closed.id, quantity: 9, firstSelectedAt: past, lastSelectedAt: past },
      { shopId: shop.id, campaignId: exhausted.id, quantity: 4, reservedQuantity: 1, committedQuantity: 3,
        exhaustedAt: past, firstSelectedAt: past, lastSelectedAt: past },
      { shopId: other.id, campaignId: global.id, quantity: 9, firstSelectedAt: past },
    ] });

    const initial = await service.read(principal, { offerPage: 1, historyPage: 1, locale: "fr" });
    assert.equal(initial.selection, null);
    assert.equal(initial.offersPagination.totalEntries, 4); // global, plan, shop, exhausted
    assert.deepEqual(new Set(initial.offers.map((offer) => offer.id)),
      new Set([global.id, planOffer.id, shopOffer.id, exhausted.id]));
    assert.equal(initial.offers.find((offer) => offer.id === global.id)?.merchantTitle, "Titre français");
    assert.equal(initial.offers.find((offer) => offer.id === planOffer.id)?.merchantTitle, "Plan");
    assert.equal(initial.offers.find((offer) => offer.id === exhausted.id)?.selectable, false);
    assert.equal(initial.history.totalEntries, 3);
    assert.equal(initial.history.entries.find((entry) => entry.campaignId === expired.id)?.status, "EXPIRED");
    assert.equal(initial.history.entries.find((entry) => entry.campaignId === closed.id)?.status, "CLOSED");
    assert.equal(initial.history.entries.find((entry) => entry.campaignId === exhausted.id)?.status, "EXHAUSTED");

    for (const id of [otherPlanOffer.id, otherShopOffer.id, expired.id, closed.id]) {
      await assert.rejects(() => service.select(principal, { campaignId: id, expectedRevision: initial.revision }),
        (error: unknown) => error instanceof PromotionDomainError && error.code === "promotion_not_eligible");
    }
    for (const id of [exhausted.id]) {
      await assert.rejects(() => service.select(principal, { campaignId: id, expectedRevision: initial.revision }),
        (error: unknown) => error instanceof PromotionDomainError && error.code === "promotion_exhausted");
    }
    assert.equal(await db.merchantPromotionSelection.count({ where: { shopId: shop.id } }), 0);

    const first = await service.select(principal, { campaignId: global.id, expectedRevision: initial.revision });
    assert.equal(first.selection.campaignId, global.id);
    assert.notEqual(first.revision, initial.revision);
    const repeated = await service.select(principal, { campaignId: global.id, expectedRevision: initial.revision });
    assert.equal(repeated.revision, first.revision); // idempotent replay of a successful selection
    assert.equal(await db.promotionalCreditGrant.count({ where: { campaignId: global.id, shopId: shop.id } }), 1);
    assert.equal((await db.promotionalCreditGrant.findUnique({
      where: { campaignId_shopId: { campaignId: global.id, shopId: shop.id } },
    }))?.selectionCount, 1);
    await assert.rejects(() => service.select(principal, { campaignId: planOffer.id, expectedRevision: initial.revision }),
      (error: unknown) => error instanceof PromotionDomainError && error.code === "promotion_revision_conflict");
    await assert.rejects(() => service.select(principal, { campaignId: planOffer.id, expectedRevision: first.revision }),
      (error: unknown) => error instanceof PromotionDomainError && error.code === "promotion_selection_locked");

    const grant = await db.promotionalCreditGrant.update({
      where: { campaignId_shopId: { campaignId: global.id, shopId: shop.id } },
      data: { reservedQuantity: 2, committedQuantity: 3, version: { increment: 1 }, firstUsedAt: now },
    });
    const afterSpend = await service.read(principal, { offerPage: 1000, historyPage: 1000, locale: "zz-XX" });
    assert.equal(afterSpend.offersPagination.page, 1);
    assert.equal(afterSpend.history.page, 1);
    assert.equal(afterSpend.selection?.remainingQuantity, 4);
    assert.equal(afterSpend.selection?.reservedQuantity, 2);
    assert.equal(afterSpend.selection?.committedQuantity, 3);
    assert.equal(afterSpend.selection?.merchantTitle, "English title");
    assert.equal(afterSpend.history.entries.find((entry) => entry.campaignId === global.id)?.status, "USED");
    assert.equal(await db.promotionalCreditGrant.count({ where: { shopId: other.id } }), 1);
    assert.equal(grant.quantity, 9);

    // An expired pointer permits another campaign, without changing the old grant.
    // Preserve the database invariant expiresAt > startsAt while expiring before `now`.
    await db.promotionCampaign.update({
      where: { id: global.id },
      data: { expiresAt: new Date("2026-10-02T12:00:00.000Z") },
    });
    const afterExpiry = await service.read(principal, { offerPage: 1, historyPage: 1, locale: "en" });
    assert.equal(afterExpiry.selection?.locked, false);
    const second = await service.select(principal, { campaignId: planOffer.id, expectedRevision: afterExpiry.revision });
    assert.equal(second.selection.campaignId, planOffer.id);
    assert.equal((await db.promotionalCreditGrant.findUnique({ where: { id: grant.id } }))?.committedQuantity, 3);
    assert.equal((await db.promotionalCreditGrant.findUnique({ where: { id: grant.id } }))?.reservedQuantity, 2);

    // The active selector is released by reconciliation; two different concurrent
    // selections using one revision can never both commit.
    await db.merchantPromotionSelection.deleteMany({ where: { shopId: shop.id } });
    const raceBase = await service.read(principal, { offerPage: 1, historyPage: 1, locale: "en" });
    const attempts = await Promise.allSettled([
      service.select(principal, { campaignId: planOffer.id, expectedRevision: raceBase.revision }),
      competingService.select(principal, { campaignId: shopOffer.id, expectedRevision: raceBase.revision }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    assert.equal(await db.merchantPromotionSelection.count({ where: { shopId: shop.id } }), 1);
    const raceGrants = await db.promotionalCreditGrant.findMany({
      where: { shopId: shop.id, campaignId: { in: [planOffer.id, shopOffer.id] } },
    });
    assert.ok(raceGrants.length >= 1 && raceGrants.length <= 2);
    assert.equal(new Set(raceGrants.map((row) => row.campaignId)).size, raceGrants.length);
    const otherRead = await service.read(otherPrincipal, { offerPage: 1, historyPage: 1, locale: "en" });
    assert.equal(otherRead.history.totalEntries, 1);
    assert.ok(otherRead.offers.every((offer) => offer.id !== shopOffer.id));
    assert.equal(await db.promotionalCreditGrant.count({ where: { shopId: other.id, campaignId: planOffer.id } }), 0);

    const extraCampaigns = await Promise.all([campaign("Extra A"), campaign("Extra B"), campaign("Extra C"), campaign("Extra D")]);
    await db.promotionalCreditGrant.createMany({ data: extraCampaigns.map((row) => ({
      shopId: shop.id, campaignId: row.id, quantity: row.quantity,
      firstSelectedAt: past, lastSelectedAt: past,
    })) });
    const offerPageOne = await service.read(principal, { offerPage: 1, historyPage: 1, locale: "en" });
    const offerPageTwo = await service.read(principal, { offerPage: 2, historyPage: 2, locale: "en" });
    assert.equal(offerPageOne.offersPagination.totalEntries, 7);
    assert.equal(offerPageOne.offers.length, 6);
    assert.equal(offerPageTwo.offers.length, 1);
    assert.equal(offerPageTwo.offersPagination.page, 2);
    assert.equal(offerPageOne.history.entries.length, 6);
    assert.ok(offerPageTwo.history.entries.length >= 2);
    assert.equal(offerPageTwo.history.page, 2);
    assert.deepEqual(new Set([...offerPageOne.offers, ...offerPageTwo.offers].map((row) => row.id)).size, 7);
    const historyRows = await db.promotionalCreditGrant.findMany({
      where: { shopId: shop.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { campaignId: true },
    });
    assert.deepEqual([...offerPageOne.history.entries, ...offerPageTwo.history.entries].map((row) => row.campaignId),
      historyRows.map((row) => row.campaignId));

    await db.subscription.update({ where: { shopId: shop.id }, data: { status: "FROZEN" } });
    await assert.rejects(() => service.read(principal, { offerPage: 1, historyPage: 1, locale: "en" }),
      (error: unknown) => error instanceof PromotionDomainError && error.code === "promotion_unavailable");
    await db.subscription.update({ where: { shopId: shop.id }, data: { status: "ACTIVE" } });
    await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { credentialVersion: { increment: 1 } } });
    await assert.rejects(() => service.read(principal, { offerPage: 1, historyPage: 1, locale: "en" }), WooUnauthenticatedError);
    await assert.rejects(() => service.read({ ...principal, shopId: other.id },
      { offerPage: 1, historyPage: 1, locale: "en" }), WooUnauthenticatedError);
    await db.wooCommerceInstallation.update({ where: { id: installation.id }, data: { status: "REVOKED", revokedAt: now } });
    await assert.rejects(() => service.read(principal, { offerPage: 1, historyPage: 1, locale: "en" }), WooUnauthenticatedError);
  } finally {
    await db.merchantPromotionSelection.deleteMany({ where: { shopId: { in: shopIds } } });
    await db.promotionalCreditGrant.deleteMany({ where: { shopId: { in: shopIds } } });
    if (campaignIds.length) await db.promotionCampaign.deleteMany({ where: { id: { in: campaignIds } } });
    await db.wooCommerceInstallation.deleteMany({ where: { shopId: { in: shopIds } } });
    await db.subscription.deleteMany({ where: { shopId: { in: shopIds } } });
    await db.shop.deleteMany({ where: { id: { in: shopIds } } });
    if (planIds.length) await db.billingPlan.deleteMany({ where: { id: { in: planIds } } });
    if (adminId) await db.platformAdmin.delete({ where: { id: adminId } });
    await competitorDb.$disconnect();
    await db.$disconnect();
  }
});
