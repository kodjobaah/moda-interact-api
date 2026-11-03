import { Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { DiscountOffersError, offerRevision, type SaveDiscountOffers, type OfferMode } from "./contract.js";

const MAX_SELECTED = 50;
const TX_TIMEOUT = 12_000;
type Database = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;
const wooRows = (shopId: string): Prisma.ShopifyDiscountWhereInput => ({
  shopId, shopifyDiscountNodeId: { startsWith: "woo:coupon:" },
  providerType: { startsWith: "WooCoupon:" },
});

type ShopRow = { id: string; domain: string; status: string; platform: string; shopifyShopId: string | null; onboardingCompleted: boolean };

async function authenticatedShop(tx: Tx, principal: WooInstallationPrincipal, lock: boolean): Promise<ShopRow> {
  const shops = lock ? await tx.$queryRaw<ShopRow[]>(Prisma.sql`
    SELECT "id", "domain", "status", "platform", "shopifyShopId", "onboardingCompleted" FROM "commerce"."Shop"
    WHERE "id"=${principal.shopId} FOR UPDATE
  `) : await tx.$queryRaw<ShopRow[]>(Prisma.sql`
    SELECT "id", "domain", "status", "platform", "shopifyShopId", "onboardingCompleted" FROM "commerce"."Shop"
    WHERE "id"=${principal.shopId}
  `);
  const shop = shops[0];
  if (!shop || shop.status !== "ACTIVE" || shop.platform !== "WOOCOMMERCE" ||
    shop.shopifyShopId !== null || shop.domain !== principal.canonicalSiteUrl) {
    throw new DiscountOffersError(409, "shop_unavailable");
  }
  const installation = await tx.wooCommerceInstallation.findUnique({where:{id:principal.installationId},select:{
    id:true,shopId:true,canonicalSiteUrl:true,status:true,credentialVersion:true,revokedAt:true,
  }});
  if (!installation || installation.shopId !== shop.id || installation.canonicalSiteUrl !== shop.domain ||
    installation.status !== "ACTIVE" || installation.credentialVersion !== principal.credentialVersion ||
    installation.revokedAt !== null) throw new DiscountOffersError(409, "shop_unavailable");
  return shop;
}

async function currentCatalogue(tx: Tx, shopId: string) {
  const catalogue = await tx.shopifyDiscountCatalogue.findUnique({where:{shopId},select:{
    status:true,syncGeneration:true,updatedAt:true,lastSuccessfulSyncAt:true,activeSyncToken:true,syncStartedAt:true,
  }});
  if (!catalogue || catalogue.status !== "CURRENT" || catalogue.lastSuccessfulSyncAt === null ||
    catalogue.activeSyncToken !== null || catalogue.syncStartedAt !== null) {
    throw new DiscountOffersError(503, "catalogue_not_current");
  }
  return catalogue;
}

/**
 * Only the provider's observed identity and ability to deliver its code matter
 * to the catalogue. Expiry, amount, usage and provider-defined coupon type are
 * WooCommerce business rules, not Moda merchant-selection restrictions.
 */
function observedWooCodes(shopId: string, generation: number): Prisma.ShopifyDiscountWhereInput {
  return {
    ...wooRows(shopId), method: "CODE", lastSeenSyncGeneration: generation,
    unavailableAt: null, providerStatus: { notIn: ["REMOVED", "UNDELIVERABLE"] },
    singleRedeemCode: { not: null },
  };
}

/** Technical transport safety only. Never shorten or reinterpret a Woo coupon code. */
function deliverableCode(code: string | null): code is string {
  return typeof code === "string" && code.trim().length > 0 &&
    ![...code].some(character => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 0x1f || point === 0x7f);
    });
}

function project(row: {
  id:string; title:string; summary:string|null; providerType:string;
  singleRedeemCode:string|null; startsAt:Date|null; endsAt:Date|null; isAvailable:boolean;
}) {
  return {id:row.id, title:row.title, summary:row.summary, providerType:row.providerType,
    code:row.singleRedeemCode, startsAt:row.startsAt?.toISOString()??null,
    endsAt:row.endsAt?.toISOString()??null, selected:row.isAvailable};
}

export class MerchantDiscountOffersService {
  constructor(private readonly database: Database, private readonly now: () => Date = () => new Date()) {}

  async catalogue(principal: WooInstallationPrincipal, query: { cursor?:string; limit:number; search?:string }) {
    return this.database.$transaction(async tx => {
      await authenticatedShop(tx, principal, false);
      const catalogue = await currentCatalogue(tx, principal.shopId);
      // Apply search independently of provider identity. Fetch bounded batches
      // so non-sendable legacy codes cannot leak or distort cursor pagination.
      const filters: Prisma.ShopifyDiscountWhereInput[] = [
        observedWooCodes(principal.shopId, catalogue.syncGeneration),
        ...(query.search ? [{ OR: [
          { title: { contains: query.search, mode: "insensitive" as const } },
          { singleRedeemCode: { contains: query.search, mode: "insensitive" as const } },
        ] }] : []),
      ];
      type CatalogueRow = {
        id: string; title: string; summary: string | null; providerType: string;
        singleRedeemCode: string | null; startsAt: Date | null; endsAt: Date | null; isAvailable: boolean;
      };
      const page: CatalogueRow[] = [];
      const batchSize = 100;
      let cursor = query.cursor;
      // The worker scan defaults to 5,000 coupons and can be configured up to
      // 20,000. This read assumes neither cap: continue until limit+1
      // genuinely sendable rows are found or the persisted catalogue ends.
      while (page.length <= query.limit) {
        const rows = await tx.shopifyDiscount.findMany({
          where: { AND: [...filters, ...(cursor ? [{ id: { gt: cursor } }] : [])] },
          orderBy: { id: "asc" }, take: batchSize,
          select: { id: true, title: true, summary: true, providerType: true,
            singleRedeemCode: true, startsAt: true, endsAt: true, isAvailable: true },
        });
        for (const row of rows) {
          if (deliverableCode(row.singleRedeemCode)) page.push(row);
          if (page.length > query.limit) break;
        }
        if (page.length > query.limit || rows.length < batchSize) break;
        cursor = rows[rows.length - 1]!.id;
      }
      const settings = await tx.shopSettings.findUnique({where:{shopId:principal.shopId},select:{updatedAt:true}});
      const hasMore = page.length > query.limit;
      const visible = page.slice(0, query.limit);
      return {schemaVersion:1,revision:offerRevision(settings?.updatedAt??null,catalogue),
        items:visible.map(project),nextCursor:hasMore?visible.at(-1)?.id??null:null,hasMore};
    }, {isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  }

  async read(principal: WooInstallationPrincipal) {
    return this.database.$transaction(async tx => {
      await authenticatedShop(tx, principal, false);
      // The merchant's saved preferences are readable even before a first
      // scan, or while Background is SYNCING, ERROR or UNAVAILABLE.
      const catalogue = await tx.shopifyDiscountCatalogue.findUnique({where:{shopId:principal.shopId},select:{
        status:true,syncGeneration:true,updatedAt:true,
      }});
      return this.projection(tx, principal.shopId, catalogue);
    }, {isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  }

  async save(principal: WooInstallationPrincipal, update: SaveDiscountOffers) {
    try {
      return await this.database.$transaction(async tx => {
        const shop = await authenticatedShop(tx, principal, true);
        // Selection is merchant-owned. Background may change catalogue status,
        // generation and provider eligibility, but never the checkbox flag.
        // Do not require CURRENT or compare the catalogue's generation on Save.
        const catalogue = await tx.shopifyDiscountCatalogue.findUnique({where:{shopId:principal.shopId}});
        const settings = await tx.shopSettings.findUnique({where:{shopId:principal.shopId},select:{
          recoveryOfferMode:true,fixedShopifyDiscountId:true,updatedAt:true,
        }});
        const now=this.now();
        const selected=[...update.selectedDiscountIds].sort();
        if (selected.length > MAX_SELECTED) throw new DiscountOffersError(422, "selection_limit_exceeded");
        if (selected.length) {
          // Identity and tenant validation only; no provider-status, expiry,
          // selectability or generation check. The provider owns those facts.
          const matches=await tx.shopifyDiscount.findMany({where:{
            ...wooRows(principal.shopId),id:{in:selected},
          },select:{id:true}});
          if (matches.length!==selected.length) throw new DiscountOffersError(422,"selected_coupon_not_found");
        }
        const currentlySelected=await tx.shopifyDiscount.findMany({where:{...wooRows(principal.shopId),isAvailable:true},select:{id:true}});
        const existingIds=currentlySelected.map(x=>x.id).sort();
        const anchor=update.recoveryOfferMode==="FIXED"?selected[0]??null:null;
        if (settings?.recoveryOfferMode === update.recoveryOfferMode &&
          settings.fixedShopifyDiscountId === anchor &&
          JSON.stringify(existingIds)===JSON.stringify(selected)) {
          return this.projection(tx,principal.shopId,catalogue);
        }
        const existingSet = new Set(existingIds);
        const selectedSet = new Set(selected);
        const removed = existingIds.filter((id) => !selectedSet.has(id));
        const added = selected.filter((id) => !existingSet.has(id));
        if (removed.length) {
          const changed = await tx.shopifyDiscount.updateMany({
            where:{...wooRows(principal.shopId),id:{in:removed},isAvailable:true},data:{isAvailable:false},
          });
          if (changed.count !== removed.length) throw new DiscountOffersError(409,"offers_conflict");
        }
        if (added.length) {
          const changed=await tx.shopifyDiscount.updateMany({
            where:{...wooRows(principal.shopId),id:{in:added},isAvailable:false},data:{isAvailable:true},
          });
          if (changed.count!==added.length) throw new DiscountOffersError(409,"offers_conflict");
        }
        const timestamp=new Date(Math.max(now.getTime(),(settings?.updatedAt.getTime()??0)+1));
        let savedSettings;
        if (settings) {
          savedSettings = await tx.shopSettings.update({where:{shopId:principal.shopId},data:{
            recoveryOfferMode:update.recoveryOfferMode,fixedShopifyDiscountId:anchor,updatedAt:timestamp,
          },select:{recoveryOfferMode:true,fixedShopifyDiscountId:true,updatedAt:true}});
        } else {
          savedSettings = await tx.shopSettings.create({data:{shopId:principal.shopId,onboardingCompleted:shop.onboardingCompleted,
            recoveryOfferMode:update.recoveryOfferMode,fixedShopifyDiscountId:anchor,updatedAt:timestamp},
            select:{recoveryOfferMode:true,fixedShopifyDiscountId:true,updatedAt:true}});
        }
        return this.projection(tx,principal.shopId,catalogue,savedSettings);
      }, {timeout:TX_TIMEOUT});
    } catch(error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002","P2034","P2003"].includes(error.code)) {
        throw new DiscountOffersError(409,"offers_conflict",{cause:error});
      }
      throw error;
    }
  }

  private async projection(tx: Tx, shopId:string, catalogue: { status: string; syncGeneration: number; updatedAt: Date } | null,
    settings?: { recoveryOfferMode: string; fixedShopifyDiscountId: string | null; updatedAt: Date } | null) {
    const savedSettings=settings === undefined ? await tx.shopSettings.findUnique({where:{shopId},select:{
      recoveryOfferMode:true,fixedShopifyDiscountId:true,updatedAt:true,
    }}) : settings;
    const selected=await tx.shopifyDiscount.findMany({where:{...wooRows(shopId),isAvailable:true},select:{id:true},orderBy:{id:"asc"},take:MAX_SELECTED+1});
    if (selected.length>MAX_SELECTED) throw new DiscountOffersError(409,"selection_limit_exceeded");
    const override=await tx.shopRecoveryPolicyOverride.findUnique({where:{shopId},select:{recoveryOfferMode:true,expiresAt:true}});
    const active=override && (override.expiresAt===null || override.expiresAt>this.now())?override:null;
    return {schemaVersion:1,revision:offerRevision(savedSettings?.updatedAt??null,catalogue),
      merchant:{recoveryOfferMode:(savedSettings?.recoveryOfferMode??"NONE") as OfferMode,
        selectedDiscountIds:selected.map(x=>x.id)},
      effective:{recoveryOfferMode:(active?.recoveryOfferMode??savedSettings?.recoveryOfferMode??"NONE") as OfferMode},
      source:active?"ADMIN_OVERRIDE":"MERCHANT",overrideActive:!!active};
  }
}
