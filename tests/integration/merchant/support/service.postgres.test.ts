import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { MerchantSupportCommandService } from "../../../../src/merchant/support/commands.service.js";
import { MerchantSupportReadService } from "../../../../src/merchant/support/read.service.js";
import { SupportConflictError,SupportNotFoundError,SupportUnavailableError } from "../../../../src/merchant/support/contract.js";

const databaseUrl=process.env.WOO_INSTALLATION_TEST_DATABASE_URL;
test("ARCH-035-API-020: concurrent replay, tenant isolation, Support visibility, offline translation and read-state",{
  skip:!databaseUrl,
},async()=>{
  if(!databaseUrl)return;
  const db=new PrismaClient({datasources:{db:{url:databaseUrl}}});
  const id=randomUUID(),shopIds:string[]=[], dispatched:string[]=[],warnings:string[]=[];
  const logger={info(){},error(){},warn(event:string){warnings.push(event);}} as never;
  const commands=new MerchantSupportCommandService(db,{async enqueue(key:string){dispatched.push(key);}},logger);
  const offline=new MerchantSupportCommandService(db,{async enqueue(){throw new Error("redis://secret");}},logger);
  const read=new MerchantSupportReadService(db);
  try{
    const domainA=`https://support-a-${id}.invalid`,domainB=`https://support-b-${id}.invalid`;
    const aShop=await db.shop.create({data:{domain:domainA,platform:"WOOCOMMERCE",defaultLanguageTag:"fr-FR"}});
    const bShop=await db.shop.create({data:{domain:domainB,platform:"WOOCOMMERCE",defaultLanguageTag:"en-GB"}});
    shopIds.push(aShop.id,bShop.id);
    const aInst=await db.wooCommerceInstallation.create({data:{shopId:aShop.id,canonicalSiteUrl:domainA,credentialDigest:Buffer.alloc(32)}});
    const bInst=await db.wooCommerceInstallation.create({data:{shopId:bShop.id,canonicalSiteUrl:domainB,credentialDigest:Buffer.alloc(32)}});
    const a={shopId:aShop.id,installationId:aInst.id,credentialVersion:aInst.credentialVersion,canonicalSiteUrl:domainA};
    const b={shopId:bShop.id,installationId:bInst.id,credentialVersion:bInst.credentialVersion,canonicalSiteUrl:domainB};
    const input={body:"Bonjour 👩‍💻",actionId:"one-action"};
    const concurrent=await Promise.all(Array.from({length:5},()=>commands.compose(a,input)));
    assert.equal(concurrent.filter(x=>x.created).length,1);
    assert.equal(new Set(concurrent.map(x=>x.response.messageId)).size,1);
    assert.equal(new Set(concurrent.map(x=>x.response.translationId)).size,1);
    assert.equal(dispatched.length,1);
    const messageId=concurrent[0]!.response.messageId;
    const stored=await db.merchantSupportMessage.findUniqueOrThrow({where:{id:messageId},include:{translations:true}});
    assert.equal(stored.shopifyUserId,null);
    assert.equal(stored.originalBody,input.body);
    assert.equal(stored.translations.length,1);
    assert.equal(stored.translations[0]?.status,"PENDING");
    assert.equal(stored.translations[0]?.direction,"MERCHANT_TO_ADMIN");
    const thread=await db.merchantSupportThread.findUniqueOrThrow({where:{shopId:aShop.id}});
    assert.equal(thread.needsAdminResponse,true);
    assert.equal(thread.merchantMessageVersion,1);
    assert.equal((await commands.compose(a,input)).response.messageId,messageId);
    await assert.rejects(commands.compose(a,{...input,body:"different"}),SupportConflictError);
    const offlineResult=await offline.compose(a,{body:"Encore",actionId:"offline"});
    assert.equal(offlineResult.created,true);
    assert.equal((await db.merchantMessageTranslation.findMany({where:{messageId:offlineResult.response.messageId,status:"PENDING"}})).length,1);
    assert.deepEqual(warnings,["merchant.support.translation_dispatch.deferred"]);
    const bSend=await commands.compose(b,{...input,body:"Shop B"});
    assert.notEqual(messageId,bSend.response.messageId);
    assert.equal(bSend.response.translationId,null);
    assert.equal((await read.read(b,{page:1,pageSize:25})).total,1);
    assert.equal((await read.read(a,{page:1,pageSize:25})).items.some(x=>x.id===bSend.response.messageId),false);
    const admin=await db.merchantSupportMessage.create({data:{threadId:thread.id,kind:"ADMINISTRATIVE",state:"AVAILABLE",
      originalBody:"English admin",sourceLanguageTag:"en-GB",displayLanguageTag:"fr-FR",availableAt:new Date()}});
    const system=await db.merchantSupportMessage.create({data:{threadId:thread.id,kind:"SYSTEM",state:"AVAILABLE",
      originalBody:"Consent warning",sourceLanguageTag:"en-GB",displayLanguageTag:"fr-FR",
      systemCode:"WHATSAPP_CONSENT_REQUIRED",systemVersion:"v1",availableAt:new Date()}});
    const pending=await db.merchantSupportMessage.create({data:{threadId:thread.id,kind:"ADMINISTRATIVE",state:"PROCESSING",
      originalBody:"processing",sourceLanguageTag:"en-GB",displayLanguageTag:"fr-FR"}});
    const failed=await db.merchantSupportMessage.create({data:{threadId:thread.id,kind:"ADMINISTRATIVE",state:"FAILED",
      originalBody:"failed",sourceLanguageTag:"en-GB",displayLanguageTag:"fr-FR"}});
    const messages=await read.read(a,{page:1,pageSize:10});
    assert.equal(messages.total,4);assert.equal(messages.unread,2);
    assert.equal(messages.items.find(x=>x.id===admin.id)?.displayBody,null);
    assert.equal(messages.items.find(x=>x.id===admin.id)?.originalBody,"");
    assert.equal(messages.items.find(x=>x.id===system.id)?.systemCode,"WHATSAPP_CONSENT_REQUIRED");
    assert.equal(messages.items.some(x=>[pending.id,failed.id].includes(x.id)),false);
    await db.merchantMessageTranslation.create({data:{messageId:admin.id,direction:"ADMIN_TO_MERCHANT",
      sourceLanguageTag:"en-GB",targetLanguageTag:"fr-FR",status:"AVAILABLE",translatedBody:"Réponse"}});
    const translated=(await read.read(a,{page:1,pageSize:10})).items.find(x=>x.id===admin.id);
    assert.equal(translated?.displayBody,"Réponse");assert.equal(translated?.isTranslated,true);
    assert.equal(translated?.originalBody,"English admin");
    for(const otherId of [bSend.response.messageId,messageId,pending.id,failed.id,randomUUID()])
      await assert.rejects(commands.markRead(a,otherId),SupportNotFoundError);
    await assert.rejects(commands.markRead(b,admin.id),SupportNotFoundError);
    const marked=await commands.markRead(a,admin.id);
    assert.deepEqual(await commands.markRead(a,admin.id),marked);
    assert.equal((await read.read(a,{page:1,pageSize:10})).unread,1);
    await db.shop.update({where:{id:aShop.id},data:{status:"SUSPENDED"}});
    assert.equal((await read.read(a,{page:1,pageSize:10})).unread,1);
    assert.equal((await commands.markRead(a,system.id)).messageId,system.id);
    await assert.rejects(commands.compose(a,{body:"no",actionId:"suspended"}),SupportUnavailableError);
    await db.shop.update({where:{id:aShop.id},data:{status:"ACTIVE"}});
    await db.wooCommerceInstallation.update({where:{id:aInst.id},data:{credentialVersion:{increment:1}}});
    await assert.rejects(read.read(a,{page:1,pageSize:25}),WooUnauthenticatedError);
    await assert.rejects(commands.compose(a,{body:"no",actionId:"stale"}),WooUnauthenticatedError);
    await db.wooCommerceInstallation.update({where:{id:aInst.id},data:{status:"REVOKED",revokedAt:new Date()}});
    await assert.rejects(read.read({...a,credentialVersion:a.credentialVersion+1},{page:1,pageSize:25}),WooUnauthenticatedError);
    assert.equal((await db.merchantSupportThread.findUniqueOrThrow({where:{shopId:aShop.id}})).merchantMessageVersion,2);
  }finally{
    if(shopIds.length)await db.shop.deleteMany({where:{id:{in:shopIds}}});
    await db.$disconnect();
  }
});
