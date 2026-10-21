import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { MAX_SUPPORT_BODY_BYTES, SUPPORT_PATH, parseSupportCompose, parseSupportQuery } from "../../../../src/merchant/support/contract.js";

test("ARCH-035-API-020 OpenAPI describes all runtime paths, schemas and Woo-only bearer authentication",async()=>{
  const source=await readFile("openapi/merchant-support-v1.yaml","utf8");
  const spec=parse(source) as {
    paths:Record<string,Record<string,{security:Array<Record<string,unknown>>;
      requestBody?:{content:Record<string,{schema:{ $ref:string }}>}}>>;
    components:{schemas:Record<string,{required?:string[];properties?:Record<string,unknown>;description?:string}>};
  };
  assert.deepEqual(Object.keys(spec.paths).sort(),[SUPPORT_PATH,`${SUPPORT_PATH}/{messageId}/read`].sort());
  for(const command of [spec.paths[SUPPORT_PATH]?.get,spec.paths[SUPPORT_PATH]?.post,
    spec.paths[`${SUPPORT_PATH}/{messageId}/read`]?.post]){
    assert.ok(command);
    assert.ok(command.security.some(x=>"InstallationBearer" in x && "InstallationId" in x));
  }
  assert.deepEqual(spec.components.schemas.ComposeCommand?.required,["body","actionId"]);
  assert.deepEqual(spec.components.schemas.ComposeReceipt?.required,["schemaVersion","messageId","translationId"]);
  assert.deepEqual(spec.components.schemas.ReadReceipt?.required,["schemaVersion","messageId","readAt"]);
  assert.deepEqual(spec.components.schemas.SupportPage?.required,["schemaVersion","page","pageSize","total","totalPages","unread","items"]);
  assert.ok(spec.components.schemas.ComposeCommand?.description?.includes(String(MAX_SUPPORT_BODY_BYTES)));
  assert.deepEqual(parseSupportQuery(new URLSearchParams("pageSize=50")),{page:1,pageSize:50});
  assert.equal(parseSupportCompose({body:"Hi",actionId:"one"}).body,"Hi");
});
