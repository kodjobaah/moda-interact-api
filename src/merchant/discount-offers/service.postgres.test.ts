import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {PrismaClient} from "@prisma/client";
import {MerchantDiscountOffersService} from "./service.js";
import {DiscountOffersError} from "./contract.js";
import type {WooInstallationPrincipal} from "../../woocommerce/installation/authenticator.js";

const url=process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

test("Woo catalogue readiness and merchant-only selection Save preserve provider state, Shopify and policy fields",{skip:!url},async()=>{
  if(!url)return;
  const db=new PrismaClient({datasources:{db:{url}}});
  const ids:string[]=[];
  try {
    const origin=`https://${randomUUID()}.discount-test.invalid`;
    const woo=await db.shop.create({data:{domain:origin,platform:"WOOCOMMERCE",status:"ACTIVE"}});
    ids.push(woo.id);
    const other=await db.shop.create({data:{domain:`${origin}-other`,platform:"WOOCOMMERCE",status:"ACTIVE"}});
    ids.push(other.id);
    const shopify=await db.shop.create({data:{domain:`${origin}-shopify`,platform:"SHOPIFY",status:"ACTIVE"}});
    ids.push(shopify.id);
    const installation=await db.wooCommerceInstallation.create({data:{shopId:woo.id,canonicalSiteUrl:origin,credentialDigest:Buffer.alloc(32)}});
    const principal:WooInstallationPrincipal={shopId:woo.id,installationId:installation.id,canonicalSiteUrl:origin,
      credentialVersion:installation.credentialVersion};
    const now=new Date("2026-10-14T01:00:00Z");
    await db.shopifyDiscountCatalogue.createMany({data:[
      {shopId:woo.id,status:"CURRENT",syncGeneration:5,lastSuccessfulSyncAt:now},
      {shopId:other.id,status:"CURRENT",syncGeneration:5,lastSuccessfulSyncAt:now},
      {shopId:shopify.id,status:"CURRENT",syncGeneration:5,lastSuccessfulSyncAt:now},
    ]});
    const make=async(shopId:string,index:number)=>db.shopifyDiscount.create({data:{
      shopId,shopifyDiscountNodeId:`woo:coupon:${index}`,providerType:"WooCoupon:percent",method:"CODE",
      providerStatus:"ACTIVE",fixedSelectable:true,codeCount:1,title:`SAVE${index}`,singleRedeemCode:`SAVE${index}`,
      providerSnapshot:{provider:"WOOCOMMERCE",amount:"10"},isAvailable:false,lastSeenSyncGeneration:5,lastSyncedAt:now,
    }});
    const one=await make(woo.id,101),two=await make(woo.id,102),foreign=await make(other.id,103);
    const shopifyCoupon=await db.shopifyDiscount.create({data:{shopId:shopify.id,shopifyDiscountNodeId:"gid://shopify/Discount/1",
      providerType:"Shopify",method:"CODE",providerStatus:"ACTIVE",fixedSelectable:true,codeCount:1,title:"SHOPIFY",singleRedeemCode:"SHOPIFY",
      providerSnapshot:{},isAvailable:true,lastSeenSyncGeneration:5,lastSyncedAt:now}});
    const service=new MerchantDiscountOffersService(db,()=>new Date("2026-10-14T01:05:00Z"));
    // Background is responsible for transitioning SYNC_REQUIRED to CURRENT.
    await db.shopifyDiscountCatalogue.update({where:{shopId:woo.id},data:{
      status:"SYNC_REQUIRED",lastSuccessfulSyncAt:null,syncGeneration:0,
    }});
    await assert.rejects(()=>service.read(principal),
      (e:unknown)=>e instanceof DiscountOffersError && e.status===503);
    await assert.rejects(()=>service.catalogue(principal,{limit:10}),
      (e:unknown)=>e instanceof DiscountOffersError && e.status===503);
    await db.shopifyDiscountCatalogue.update({where:{shopId:woo.id},data:{
      status:"CURRENT",lastSuccessfulSyncAt:now,syncGeneration:5,
    }});
    const original=await service.read(principal);
    assert.equal(original.merchant.recoveryOfferMode,"NONE");
    const page=await service.catalogue(principal,{limit:1});
    assert.equal(page.items.length,1);assert.ok(page.nextCursor);
    const second=await service.catalogue(principal,{limit:1,cursor:page.nextCursor!});
    assert.equal(second.items.length,1);assert.equal(second.items[0]?.selected,false);
    await assert.rejects(()=>service.save(principal,{recoveryOfferMode:"FIXED",
      selectedDiscountIds:[one.id,foreign.id]}), (e:unknown)=>e instanceof DiscountOffersError && e.status===422);
    const saved=await service.save(principal,{recoveryOfferMode:"FIXED",
      selectedDiscountIds:[two.id,one.id]});
    assert.equal(saved.merchant.recoveryOfferMode,"FIXED");
    assert.deepEqual(saved.merchant.selectedDiscountIds,[one.id,two.id].sort());
    const settings=await db.shopSettings.findUniqueOrThrow({where:{shopId:woo.id}});
    assert.equal(settings.fixedShopifyDiscountId,[one.id,two.id].sort()[0]);
    assert.equal(settings.recoveryDelayMinutes,30);
    // Existing recovery delay/follow-up fields are independent of coupon configuration.
    // Set them through the existing database model; no recovery-policy route exists
    // in this task snapshot and API-002 must not manufacture one.
    await db.shopSettings.update({where:{shopId:woo.id},data:{
      recoveryDelayMinutes:45, followUpEnabled:true, followUpDelayMinutes:60,
    }});
    // No optimistic generation/settings conflict: a merchant can change their
    // selection regardless of an unrelated settings timestamp update.
    const cleared=await service.save(principal,{recoveryOfferMode:"AI_BEST_APPLICABLE",
      selectedDiscountIds:[one.id,two.id]});
    assert.equal((await db.shopSettings.findUniqueOrThrow({where:{shopId:woo.id}})).fixedShopifyDiscountId,null);
    assert.equal(cleared.merchant.selectedDiscountIds.length,2);
    const retained=await db.shopSettings.findUniqueOrThrow({where:{shopId:woo.id}});
    assert.equal(retained.recoveryDelayMinutes,45);
    assert.equal(retained.followUpEnabled,true);
    assert.equal(retained.followUpDelayMinutes,60);
    assert.equal((await db.shopifyDiscount.findUniqueOrThrow({where:{id:shopifyCoupon.id}})).isAvailable,true);
    // The merchant's checkbox may remain true after Background marks the
    // provider coupon removed/unsupported; Save never reinterprets provider facts.
    await db.shopifyDiscount.update({where:{id:one.id},data:{
      providerStatus:"REMOVED",fixedSelectable:false,unavailableAt:new Date("2026-10-14T01:07:00Z"),
    }});
    await db.shopifyDiscountCatalogue.update({where:{shopId:woo.id},data:{syncGeneration:6,status:"SYNCING",activeSyncToken:"background-scan",syncStartedAt:new Date("2026-10-14T01:06:00Z")}});
    await assert.rejects(()=>service.catalogue(principal,{limit:10}),
      (e:unknown)=>e instanceof DiscountOffersError && e.status===503);
    await assert.rejects(()=>service.read(principal),
      (e:unknown)=>e instanceof DiscountOffersError && e.status===503);
    // Save is tenant-owned and does not check CURRENT, generation or coupon eligibility.
    const savedDuringSync=await service.save(principal,{recoveryOfferMode:"FIXED",selectedDiscountIds:[one.id]});
    assert.deepEqual(savedDuringSync.merchant.selectedDiscountIds,[one.id]);
    assert.equal((await db.shopifyDiscount.findUniqueOrThrow({where:{id:one.id}})).providerStatus,"REMOVED");
    assert.equal((await db.shopifyDiscount.findUniqueOrThrow({where:{id:one.id}})).isAvailable,true);
    assert.equal((await db.shopifyDiscount.findUniqueOrThrow({where:{id:two.id}})).isAvailable,false);
    const repeated=await service.save(principal,{recoveryOfferMode:"FIXED",selectedDiscountIds:[one.id]});
    assert.deepEqual(repeated.merchant.selectedDiscountIds,[one.id]);
    assert.equal((await db.shopSettings.findUniqueOrThrow({where:{shopId:woo.id}})).fixedShopifyDiscountId,one.id);
    // Provider outage does not lock the merchant configuration Save either.
    await db.shopifyDiscountCatalogue.update({where:{shopId:woo.id},data:{status:"UNAVAILABLE",activeSyncToken:null,syncStartedAt:null}});
    await service.save(principal,{recoveryOfferMode:"NONE",selectedDiscountIds:[one.id]});
    assert.equal((await db.shopSettings.findUniqueOrThrow({where:{shopId:woo.id}})).fixedShopifyDiscountId,null);
    assert.equal((await db.shopifyDiscount.findUniqueOrThrow({where:{id:one.id}})).isAvailable,true);
    await assert.rejects(()=>service.save(principal,{recoveryOfferMode:"FIXED",selectedDiscountIds:[foreign.id]}),
      (e:unknown)=>e instanceof DiscountOffersError && e.status===422);
    await assert.rejects(()=>service.save(principal,{recoveryOfferMode:"FIXED",selectedDiscountIds:["non-existent-discount"]}),
      (e:unknown)=>e instanceof DiscountOffersError && e.status===422);
    await assert.rejects(()=>service.read({...principal,shopId:shopify.id}),DiscountOffersError);
  } finally {
    for(const id of ids)await db.shop.delete({where:{id}}).catch(()=>{});
    await db.$disconnect();
  }
});
