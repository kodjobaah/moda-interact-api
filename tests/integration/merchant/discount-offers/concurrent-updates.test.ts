import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, PrismaClient } from "@prisma/client";
import { MerchantDiscountOffersService } from "../../../../src/merchant/discount-offers/service.js";
import type { WooInstallationPrincipal } from "../../../../src/woocommerce/installation/authenticator.js";

const url = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Seed only existing migrated tables; never bypass the ARCH-016 FK/CHECK constraints. */
async function fixture(db: PrismaClient) {
  const origin = `https://${randomUUID()}.api002-race.invalid`;
  const shop = await db.shop.create({data:{domain:origin,platform:"WOOCOMMERCE",status:"ACTIVE"}});
  try {
    const installation = await db.wooCommerceInstallation.create({data:{
      shopId:shop.id,canonicalSiteUrl:origin,credentialDigest:Buffer.alloc(32),
    }});
    await db.shopifyDiscountCatalogue.create({data:{
      shopId:shop.id,status:"CURRENT",syncGeneration:1,lastSuccessfulSyncAt:new Date("2026-10-14T01:00:00Z"),
    }});
    const codes = ["RACE10","RACE20","RACE30"];
    const coupons = [];
    for (let i=0;i<codes.length;i++) {
      coupons.push(await db.shopifyDiscount.create({data:{
        shopId:shop.id,shopifyDiscountNodeId:`woo:coupon:${i+1}`,providerType:"WooCoupon:percent",
        method:"CODE",providerStatus:"ACTIVE",fixedSelectable:true,codeCount:1,
        singleRedeemCode:codes[i]!,title:codes[i]!,providerSnapshot:{provider:"WOOCOMMERCE",amount:"10"},
        isAvailable:false,lastSeenSyncGeneration:1,lastSyncedAt:new Date("2026-10-14T01:00:00Z"),
      }}));
    }
    const principal:WooInstallationPrincipal = {
      shopId:shop.id,installationId:installation.id,canonicalSiteUrl:origin,
      credentialVersion:installation.credentialVersion,
    };
    return {shopId:shop.id,coupons,principal};
  } catch (error) {
    await db.shop.delete({where:{id:shop.id}});
    throw error;
  }
}

async function selected(db:PrismaClient,shopId:string) {
  return db.shopifyDiscount.findMany({where:{shopId,isAvailable:true},select:{id:true},orderBy:{id:"asc"}})
    .then(rows=>rows.map(row=>row.id));
}

test("two overlapping Woo merchant Saves produce one complete last-writer set and FK anchor",{skip:!url},async()=>{
  if(!url)return;
  const db=new PrismaClient({datasources:{db:{url}}});
  let shopId:string|undefined;
  try {
    const f=await fixture(db);shopId=f.shopId;
    const service=new MerchantDiscountOffersService(db,()=>new Date("2026-10-14T01:05:00Z"));
    const firstSet=[f.coupons[0]!.id,f.coupons[1]!.id].sort();
    const secondSet=[f.coupons[2]!.id];
    const lockEntered=deferred();const releaseLock=deferred();
    // Hold the Shop row so both independent Saves are in flight together,
    // rather than accidentally running sequentially in this test process.
    const holder=db.$transaction(async(tx)=>{
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${f.shopId} FOR UPDATE`);
      lockEntered.resolve();
      await releaseLock.promise;
    },{timeout:10_000});
    await lockEntered.promise;
    const first=service.save(f.principal,{recoveryOfferMode:"FIXED",selectedDiscountIds:firstSet});
    const second=service.save(f.principal,{recoveryOfferMode:"AI_BEST_APPLICABLE",selectedDiscountIds:secondSet});
    try {
      const outcome=await Promise.race([
        Promise.allSettled([first,second]).then(()=>"finished"),delay(80).then(()=>"blocked"),
      ]);
      assert.equal(outcome,"blocked","both Saves must still be waiting for the Shop lock");
    } finally {
      releaseLock.resolve();
    }
    await holder;
    const [firstResponse,secondResponse]=await Promise.all([first,second]);
    assert.deepEqual(firstResponse.merchant.selectedDiscountIds,firstSet);
    assert.deepEqual(secondResponse.merchant.selectedDiscountIds,secondSet);
    const settings=await db.shopSettings.findUniqueOrThrow({where:{shopId:f.shopId}});
    const final=await selected(db,f.shopId);
    if(settings.recoveryOfferMode==="FIXED") {
      assert.deepEqual(final,firstSet,"FIXED winner must not contain any part of the AI set");
      assert.equal(settings.fixedShopifyDiscountId,firstSet[0]);
    } else {
      assert.equal(settings.recoveryOfferMode,"AI_BEST_APPLICABLE");
      assert.deepEqual(final,secondSet,"AI winner must not contain any part of the FIXED set");
      assert.equal(settings.fixedShopifyDiscountId,null);
    }
  } finally {
    if(shopId)await db.shop.delete({where:{id:shopId}}).catch(()=>{});
    await db.$disconnect();
  }
});

test("Background-style scan overlapping a Save preserves provider status and merchant checkbox",{skip:!url},async()=>{
  if(!url)return;
  const db=new PrismaClient({datasources:{db:{url}}});
  let shopId:string|undefined;
  try {
    const f=await fixture(db);shopId=f.shopId;
    const coupon=f.coupons[0]!;
    const service=new MerchantDiscountOffersService(db,()=>new Date("2026-10-14T01:05:00Z"));
    const scanEntered=deferred();const releaseScan=deferred();
    // Model the accepted Background writer: it owns provider fields and the
    // catalogue generation, not the merchant-owned isAvailable flag.
    const scan=db.$transaction(async tx=>{
      await tx.$queryRaw(Prisma.sql`
        SELECT "shopId" FROM "shopify"."ShopifyDiscountCatalogue"
        WHERE "shopId"=${f.shopId} FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "shopify"."ShopifyDiscount" WHERE "id"=${coupon.id} FOR UPDATE
      `);
      await tx.shopifyDiscount.update({where:{id:coupon.id},data:{
        providerStatus:"REMOVED",fixedSelectable:false,unavailableAt:new Date("2026-10-14T01:07:00Z"),
        lastSeenSyncGeneration:2,lastSyncedAt:new Date("2026-10-14T01:07:00Z"),
      }});
      await tx.shopifyDiscountCatalogue.update({where:{shopId:f.shopId},data:{
        status:"CURRENT",syncGeneration:2,lastSuccessfulSyncAt:new Date("2026-10-14T01:07:00Z"),
      }});
      scanEntered.resolve();
      await releaseScan.promise;
    },{timeout:10_000});
    await scanEntered.promise;
    const saving=service.save(f.principal,{recoveryOfferMode:"FIXED",selectedDiscountIds:[coupon.id]});
    try {
      const outcome=await Promise.race([saving.then(()=>"finished",()=>"failed"),delay(80).then(()=>"blocked")]);
      assert.equal(outcome,"blocked","merchant Save must not override an in-flight provider update");
    } finally {
      releaseScan.resolve();
    }
    await scan;
    const response=await saving;
    assert.deepEqual(response.merchant.selectedDiscountIds,[coupon.id]);
    const final=await db.shopifyDiscount.findUniqueOrThrow({where:{id:coupon.id}});
    assert.equal(final.isAvailable,true,"the merchant selection survives");
    assert.equal(final.providerStatus,"REMOVED","the provider status survives");
    assert.equal(final.fixedSelectable,false,"the provider selectability survives");
    assert.equal(final.lastSeenSyncGeneration,2);
    assert.equal((await db.shopifyDiscountCatalogue.findUniqueOrThrow({where:{shopId:f.shopId}})).syncGeneration,2);
    assert.equal((await db.shopSettings.findUniqueOrThrow({where:{shopId:f.shopId}})).fixedShopifyDiscountId,coupon.id);
  } finally {
    if(shopId)await db.shop.delete({where:{id:shopId}}).catch(()=>{});
    await db.$disconnect();
  }
});
