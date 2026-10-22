import assert from "node:assert/strict";
import test from "node:test";
import { PromotionDomainError } from "../../../../src/merchant/promotions/contract.js";
import { promotionRevision } from "../../../../src/merchant/promotions/context.js";
import { MerchantPromotionsService } from "../../../../src/merchant/promotions/service.js";

const now = new Date("2026-10-22T12:00:00.000Z");
const future = new Date("2026-12-31T00:00:00.000Z");
const past = new Date("2026-10-01T00:00:00.000Z");
const shopId = "woo-shop";
const principal = { shopId, canonicalSiteUrl: "https://woo.invalid", installationId: "woo-i", credentialVersion: 1 };
const context = { shopId, planId: "plan-a", subscriptionId: "subscription-a", subscriptionStatus: "ACTIVE",
  subscriptionUpdatedAt: new Date("2026-09-01T00:00:00.000Z") };

/** Narrow in-memory Prisma seam: verifies the command never resets grant quantities. */
function fakePersistence() {
  const campaigns = new Map(["campaign-a", "campaign-b", "campaign-foreign"].map((id) => [id, {
    id, name: id, quantity: 8, status: "ACTIVE", scope: id === "campaign-foreign" ? "SHOP" : "GLOBAL",
    startsAt: past, expiresAt: future,
    targetShopId: id === "campaign-foreign" ? "foreign-shop" : null, targetPlanId: null,
    translations: [{ locale: "en", merchantTitle: id }],
  }] as const));
  const grants = new Map<string, {
    id: string; shopId: string; campaignId: string; quantity: number; reservedQuantity: number;
    committedQuantity: number; exhaustedAt: Date | null; version: number; firstSelectedAt: Date | null;
    lastSelectedAt: Date | null; selectionCount: number;
  }>();
  let selected: { id: string; version: number; updatedAt: Date; promotionalCreditGrantId: string } | null = null;
  const models = {
    $queryRaw: async (query: { strings: string[] }) => {
      if (query.strings.join(" ").includes('"WooCommerceInstallation"')) {
        return [{ id: principal.installationId, shopId, canonicalSiteUrl: principal.canonicalSiteUrl,
          status: "ACTIVE", credentialVersion: 1, revokedAt: null }];
      }
      return [{ id: shopId, domain: principal.canonicalSiteUrl, platform: "WOOCOMMERCE",
        shopifyShopId: null, status: "ACTIVE" }];
    },
    subscription: { findUnique: async () => ({ id: context.subscriptionId, status: "ACTIVE", planId: context.planId,
      updatedAt: context.subscriptionUpdatedAt, plan: { id: context.planId, active: true } }) },
    merchantPromotionSelection: {
      findUnique: async () => {
        if (!selected) return null;
        const grant = [...grants.values()].find((row) => row.id === selected!.promotionalCreditGrantId)!;
        return { ...selected, promotionalCreditGrant: {
          id: grant.id, shopId, quantity: grant.quantity, reservedQuantity: grant.reservedQuantity,
          committedQuantity: grant.committedQuantity, exhaustedAt: grant.exhaustedAt, version: grant.version,
          campaign: campaigns.get(grant.campaignId),
        } };
      },
      upsert: async (input: { create: { promotionalCreditGrantId: string }; update: { promotionalCreditGrantId: string } }) => {
        if (!selected) selected = { id: "selection", version: 0, updatedAt: now,
          promotionalCreditGrantId: input.create.promotionalCreditGrantId };
        else selected = { ...selected, version: selected.version + 1,
          promotionalCreditGrantId: input.update.promotionalCreditGrantId, updatedAt: now };
      },
    },
    promotionCampaign: { findUnique: async (input: { where: { id: string } }) => campaigns.get(input.where.id) ?? null },
    promotionalCreditGrant: {
      upsert: async (input: { where: { campaignId_shopId: { campaignId: string } }; create: { quantity: number } }) => {
        const campaignId = input.where.campaignId_shopId.campaignId;
        if (!grants.has(campaignId)) grants.set(campaignId, {
          id: `grant-${campaignId}`, campaignId, shopId, quantity: input.create.quantity,
          reservedQuantity: 0, committedQuantity: 0, exhaustedAt: null, version: 0,
          firstSelectedAt: null, lastSelectedAt: null, selectionCount: 0,
        });
        return grants.get(campaignId)!;
      },
      update: async (input: { where: { id_shopId: { id: string } }; data: { firstSelectedAt: Date;
        lastSelectedAt: Date; selectionCount: { increment: number } } }) => {
        const grant = [...grants.values()].find((row) => row.id === input.where.id_shopId.id)!;
        grant.firstSelectedAt = input.data.firstSelectedAt;
        grant.lastSelectedAt = input.data.lastSelectedAt;
        grant.selectionCount += input.data.selectionCount.increment;
      },
    },
  };
  const db = { $transaction: async (fn: (tx: typeof models) => Promise<unknown>) => fn(models) };
  return { service: new MerchantPromotionsService(db as never, () => now), campaigns, grants,
    revision: () => promotionRevision(context, selected ? ({
      ...selected, promotionalCreditGrant: (() => {
        const grant = [...grants.values()].find((row) => row.id === selected!.promotionalCreditGrantId)!;
        return { ...grant, campaign: campaigns.get(grant.campaignId) };
      })(),
    }) as never : null) };
}

test("selection is idempotent and a different active selection cannot bypass revision or lock", async () => {
  const fixture = fakePersistence(); const original = fixture.revision();
  const saved = await fixture.service.select(principal, { campaignId: "campaign-a", expectedRevision: original });
  assert.equal(saved.selection.remainingQuantity, 8);
  assert.notEqual(saved.revision, original);
  const repeated = await fixture.service.select(principal, { campaignId: "campaign-a", expectedRevision: original });
  assert.equal(repeated.revision, saved.revision);
  assert.equal(fixture.grants.get("campaign-a")?.selectionCount, 1);
  await assert.rejects(() => fixture.service.select(principal, { campaignId: "campaign-b", expectedRevision: original }),
    (error: unknown) => error instanceof PromotionDomainError && error.code === "promotion_revision_conflict");
  await assert.rejects(() => fixture.service.select(principal, { campaignId: "campaign-b", expectedRevision: saved.revision }),
    (error: unknown) => error instanceof PromotionDomainError && error.code === "promotion_selection_locked");
  assert.equal(fixture.grants.size, 1);
});

test("expired selection permits replacement without resetting old grant balances", async () => {
  const fixture = fakePersistence();
  const saved = await fixture.service.select(principal, { campaignId: "campaign-a", expectedRevision: fixture.revision() });
  const grant = fixture.grants.get("campaign-a")!;
  grant.committedQuantity = 3; grant.reservedQuantity = 2; grant.version += 1;
  const selectedCampaign = fixture.campaigns.get("campaign-a")!;
  fixture.campaigns.set("campaign-a", { ...selectedCampaign, expiresAt: past });
  const replaced = await fixture.service.select(principal, { campaignId: "campaign-b", expectedRevision: fixture.revision() });
  assert.notEqual(replaced.revision, saved.revision);
  assert.equal(replaced.selection.campaignId, "campaign-b");
  assert.deepEqual([grant.quantity, grant.reservedQuantity, grant.committedQuantity, grant.selectionCount], [8, 2, 3, 1]);
  const oldRevision = fixture.revision();
  await assert.rejects(() => fixture.service.select(principal, { campaignId: "campaign-foreign", expectedRevision: oldRevision }),
    (error: unknown) => error instanceof PromotionDomainError && error.code === "promotion_not_eligible");
});
