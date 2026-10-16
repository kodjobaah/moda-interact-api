import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMerchantDiscountOffersRoutes } from "../../../../src/merchant/discount-offers/routes.js";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";

function harness(method: string, path: string, input?: unknown, denied = false) {
  const calls: string[] = [];
  const bytes = input===undefined?null:Buffer.from(JSON.stringify(input));
  const request = {method,url:path,rawHeaders:bytes?["Content-Type","application/json","Content-Length",String(bytes.length)]:[],
    async *[Symbol.asyncIterator]() {if(bytes)yield bytes;}} as unknown as IncomingMessage;
  const output:{status?:number;headers?:Record<string,string>;body?:unknown}={};
  const response={destroyed:false,headersSent:false,
    writeHead(status:number,headers:Record<string,string>){output.status=status;output.headers=headers;return this;},
    end(text:string){output.body=JSON.parse(text) as unknown;return this;}} as unknown as ServerResponse;
  const route=createMerchantDiscountOffersRoutes({
    authenticator:{async authenticate(){if(denied)throw new WooUnauthenticatedError();return {shopId:"woo-shop",installationId:"inst",canonicalSiteUrl:"https://woo.test",credentialVersion:1};}} as never,
    service:{
      async catalogue(){calls.push("catalogue");return {schemaVersion:1,items:[]};},
      async read(){calls.push("read");return {schemaVersion:1,merchant:{recoveryOfferMode:"NONE"}};},
      async save(){calls.push("save");return {schemaVersion:1,merchant:{recoveryOfferMode:"FIXED"}};},
    } as never,
    logger:{info(){},warn(){},error(){}} as never,
  });
  return {route,request,response,output,calls};
}

test("Woo merchant coupon endpoints use installation authentication and no-store responses",async()=>{
  const get=harness("GET","/v1/merchant/discount-catalogue?limit=2");
  assert.equal(await get.route.handle(get.request,get.response),true);
  assert.equal(get.output.status,200);
  assert.equal(get.output.headers?.["cache-control"],"no-store");
  assert.deepEqual(get.calls,["catalogue"]);
  const settings=harness("GET","/v1/merchant/discount-offers");
  await settings.route.handle(settings.request,settings.response);
  assert.equal(settings.output.status,200);
  assert.deepEqual(settings.calls,["read"]);
  assert.equal(settings.output.headers?.["cache-control"],"no-store");
  const denied=harness("GET","/v1/merchant/discount-offers",undefined,true);
  await denied.route.handle(denied.request,denied.response);
  assert.equal(denied.output.status,401);
  assert.deepEqual(denied.calls,[]);
  const put=harness("PUT","/v1/merchant/discount-offers",{
    recoveryOfferMode:"FIXED",selectedDiscountIds:["coupon-one"]});
  await put.route.handle(put.request,put.response);
  assert.equal(put.output.status,200);
  assert.deepEqual(put.calls,["save"]);
  const stale=harness("PUT","/v1/merchant/discount-offers",{
    expectedRevision:"stale",recoveryOfferMode:"NONE",selectedDiscountIds:[]});
  await stale.route.handle(stale.request,stale.response);
  assert.equal(stale.output.status,400); // obsolete revision key is not part of Save
  assert.deepEqual(stale.calls,[]);
  const invalid=harness("PUT","/v1/merchant/discount-offers",{
    recoveryOfferMode:"FIXED",selectedDiscountIds:[]});
  await invalid.route.handle(invalid.request,invalid.response);
  assert.equal(invalid.output.status,422);
  assert.deepEqual(invalid.calls,[]);
  assert.equal(await get.route.handle({method:"POST",url:"/v1/merchant/discount-offers"} as IncomingMessage,get.response),false);
});
