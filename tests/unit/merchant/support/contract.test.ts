import assert from "node:assert/strict";
import test from "node:test";
import { parseSupportCompose,parseSupportQuery,SupportRequestError,validSupportPage,
  validComposeResponse,validReadResponse } from "../../../../src/merchant/support/contract.js";
import { supportSourceKey } from "../../../../src/merchant/support/commands.service.js";

test("page and pageSize are exact bounded values with no extra query parameters", () => {
  assert.deepEqual(parseSupportQuery(new URLSearchParams()),{page:1,pageSize:25});
  for (const size of [10,25,50]) assert.deepEqual(parseSupportQuery(new URLSearchParams(`page=2&pageSize=${size}`)),{page:2,pageSize:size});
  for (const bad of ["page=0","page=1000000","page=1.0","page=-1","page=1&page=2",
    "pageSize=5","pageSize=25&pageSize=10","shopId=other","page=01"]) {
    assert.throws(() => parseSupportQuery(new URLSearchParams(bad)),SupportRequestError);
  }
});
test("Shared Unicode grapheme contract accepts 500 and rejects 501 and identity injection", () => {
  assert.equal(parseSupportCompose({body:"👩‍💻".repeat(500),actionId:"abc"}).body,"👩‍💻".repeat(500));
  for (const bad of [{body:"👩‍💻".repeat(501),actionId:"a"},{body:"",actionId:"a"},
    {body:"ok",actionId:"a",shopId:"other"},{body:"ok",actionId:"a",shopifyUserId:"other"},
    {body:"ok",actionId:"a",platformAdminId:"other"},{body:"ok",actionId:"bad:"},
    {body:"ok",actionId:"a".repeat(129)},{body:2,actionId:"a"}]) {
    assert.throws(() => parseSupportCompose(bad),SupportRequestError);
  }
});
test("action IDs are stable and tenant separated without storing raw tenant IDs", () => {
  const key=supportSourceKey("shop-a","action-1");
  assert.match(key,/^woo-support:[a-f0-9]{64}$/);
  assert.equal(key,supportSourceKey("shop-a","action-1"));
  assert.notEqual(key,supportSourceKey("shop-b","action-1"));
  assert.notEqual(key,supportSourceKey("shop-a","action-2"));
});
test("strict schemaVersion 2 history requires a nullable recovery reference", () => {
  const item={id:"msg-1",kind:"SYSTEM",state:"AVAILABLE",originalBody:"Hello",displayBody:"Hello",
    isTranslated:false,sourceLanguageTag:"en-GB",displayLanguageTag:null,systemCode:null,systemVersion:null,
    createdAt:new Date().toISOString(),readAt:null,checkoutRecoveryId:null};
  const page={schemaVersion:2,page:1,pageSize:25,total:1,totalPages:1,unread:0,items:[item]};
  assert.equal(validSupportPage(page),true);
  assert.equal(validSupportPage({...page,schemaVersion:1}),false);
  assert.equal(validSupportPage({...page,items:[{...item,checkoutRecoveryId:"recovery_123"}]}),true);
  assert.equal(validSupportPage({...page,items:[{...item,checkoutRecoveryId:"bad:id"}]}),false);
  assert.equal(validSupportPage({...page,items:[Object.fromEntries(Object.entries(item).filter(([key])=>key!=="checkoutRecoveryId"))]}),false);
  assert.equal(validSupportPage({...page,shopId:"other"}),false);
  assert.equal(validSupportPage({...page,pageSize:9}),false);
  assert.equal(validComposeResponse({schemaVersion:1,messageId:"msg-1",translationId:null}),true);
  assert.equal(validComposeResponse({schemaVersion:1,messageId:"msg-1",translationId:null,userId:"a"}),false);
  assert.equal(validReadResponse({schemaVersion:1,messageId:"msg-1",readAt:new Date().toISOString()}),true);
  assert.equal(validReadResponse({schemaVersion:1,messageId:"msg-1",readAt:"bad"}),false);
});
