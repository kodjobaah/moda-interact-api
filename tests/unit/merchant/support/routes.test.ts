import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage,ServerResponse } from "node:http";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { SupportConflictError,SupportNotFoundError,SupportUnavailableError } from "../../../../src/merchant/support/contract.js";
import { createMerchantSupportRoutes } from "../../../../src/merchant/support/routes.js";

const principal={shopId:"shop-a",installationId:"woo-a",canonicalSiteUrl:"https://a.invalid",credentialVersion:1};
const send=JSON.stringify({body:"Hello",actionId:"a1"});
const page={schemaVersion:1,page:1,pageSize:25,total:0,totalPages:1,unread:0,items:[]};
const receipt={schemaVersion:1,messageId:"msg-1",translationId:null};
const marked={schemaVersion:1,messageId:"msg-1",readAt:"2026-10-21T12:00:00.000Z"};
function request(method:string,url:string,body="",headers:string[]=[]):IncomingMessage {
  const req=Readable.from([Buffer.from(body)]) as IncomingMessage;
  req.method=method;req.url=url;req.rawHeaders=headers;return req;
}
function response(){ let code=0;let body="";let headers:Record<string,string>={};
  const out={destroyed:false,headersSent:false,writeHead(c:number,h:Record<string,string>){code=c;headers=h;},
    end(value:string){body=value;}} as unknown as ServerResponse;
  return {out,get:()=>({code,headers,payload:JSON.parse(body) as unknown})}; }
function make(error?:Error){const calls:string[]=[],logs:string[]=[];
  const route=createMerchantSupportRoutes({
    authenticator:{async authenticate(_req:unknown,options:unknown){calls.push(`auth:${JSON.stringify(options)}`);
      if(error instanceof WooUnauthenticatedError)throw error;return principal;}} as never,
    read:{async read(){calls.push("list");if(error)throw error;return page;}} as never,
    commands:{async compose(){calls.push("compose");if(error)throw error;return {response:receipt,created:true};},
      async markRead(){calls.push("mark");if(error)throw error;return marked;}} as never,
    logger:{info(...args:unknown[]){logs.push(JSON.stringify(args));},
      warn(...args:unknown[]){logs.push(JSON.stringify(args));},
      error(...args:unknown[]){logs.push(JSON.stringify(args));}} as never});return {route,calls,logs}; }
test("GET, compose and mark-read are Woo-authenticated and cache-disabled",async()=>{
  const a=make(),out=response();
  assert.equal(await a.route.handle(request("GET","/v1/merchant/support/messages"),out.out),true);
  assert.equal(out.get().code,200);assert.deepEqual(out.get().payload,page);
  assert.equal(out.get().headers["cache-control"],"no-store");
  assert.deepEqual(a.calls,['auth:{"allowSuspendedShop":true}',"list"]);
  const b=make(),sent=response();
  await b.route.handle(request("POST","/v1/merchant/support/messages",send,["content-type","application/json"]),sent.out);
  assert.equal(sent.get().code,201);assert.deepEqual(sent.get().payload,receipt);
  const c=make(),read=response();
  await c.route.handle(request("POST","/v1/merchant/support/messages/msg-1/read"),read.out);
  assert.equal(read.get().code,200);assert.deepEqual(read.get().payload,marked);
  assert.equal(await c.route.handle(request("DELETE","/v1/merchant/support/messages"),response().out),false);
});
test("invalid queries, bodies, duplicate keys and supplied identities are rejected before service",async()=>{
  const bad=[request("GET","/v1/merchant/support/messages?shopId=other"),
    request("GET","/v1/merchant/support/messages?pageSize=51"),
    request("POST","/v1/merchant/support/messages",'{"body":"one","body":"two","actionId":"a"}',["content-type","application/json"]),
    request("POST","/v1/merchant/support/messages",'{"body":"ok","actionId":"a","shopId":"other"}',["content-type","application/json"]),
    request("POST","/v1/merchant/support/messages",send,["content-type","text/plain"]),
    request("POST","/v1/merchant/support/messages",send,["content-type","application/json","content-type","application/json"]),
    request("POST","/v1/merchant/support/messages/msg-1/read","{}",["content-length","2"]),
    request("POST","/v1/merchant/support/messages/msg.1/read")];
  for(const req of bad){const api=make(),out=response();await api.route.handle(req,out.out);
    assert.equal(out.get().code,400,req.url);assert.deepEqual(api.calls,['auth:{"allowSuspendedShop":true}']);}
  const api=make(),out=response();
  await api.route.handle(request("POST","/v1/merchant/support/messages","x".repeat(32769),["content-type","application/json"]),out.out);
  assert.equal(out.get().code,413);
});
test("safe errors distinguish auth, not-found, suspended write, conflict and internal failure",async()=>{
  for(const [error,status,code] of [[new WooUnauthenticatedError(),401,"unauthorized"],
    [new SupportNotFoundError(),404,"not_found"],[new SupportUnavailableError(),403,"support_unavailable"],
    [new SupportConflictError(),409,"idempotency_conflict"],
    [new Error("postgres://password@host"),500,"internal_error"]] as const){
    const api=make(error),out=response();
    await api.route.handle(request("POST","/v1/merchant/support/messages",send,["content-type","application/json"]),out.out);
    assert.equal(out.get().code,status);assert.deepEqual(out.get().payload,{error:code});
    assert.doesNotMatch(JSON.stringify(out.get())+JSON.stringify(api.logs),/password@host/);
  }
});
