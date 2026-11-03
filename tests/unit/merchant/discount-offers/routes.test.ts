import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { createLogger, LOG_VALUE_LIMITS, type StructuredLogger, type LogRecord } from "@modainteract/moda-interact-shared/logging";
import { DiscountOffersError } from "../../../../src/merchant/discount-offers/contract.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMerchantDiscountOffersRoutes } from "../../../../src/merchant/discount-offers/routes.js";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";

function harness(method: string, path: string, input?: unknown, denied = false, failure?: Error, logger?: StructuredLogger) {
  const calls: string[] = [];
  const logs: unknown[] = [];
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
      async catalogue(){calls.push("catalogue");if(failure)throw failure;return {schemaVersion:1,items:[]};},
      async read(){calls.push("read");if(failure)throw failure;return {schemaVersion:1,merchant:{recoveryOfferMode:"NONE"}};},
      async save(){calls.push("save");if(failure)throw failure;return {schemaVersion:1,merchant:{recoveryOfferMode:"FIXED"}};},
    } as never,
    logger:logger ?? {info(){},warn(_event:string,fields:unknown){logs.push(fields);},error(_event:string,fields:unknown){logs.push(fields);}} as never,
  });
  return {route,request,response,output,calls,logs};
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

test("discount failure diagnostics redact credentials before logging",async()=>{
  const failed=harness("GET","/v1/merchant/discount-offers",undefined,false,
    new Error("secret credential postgres://private"));
  await failed.route.handle(failed.request,failed.response);
  assert.equal(failed.output.status,500);
  assert.equal(JSON.stringify(failed.logs).includes("secret"),false);
  assert.equal(JSON.stringify(failed.logs).includes("postgres://private"),false);
});


test("discount routes retain wrapped database cause/code through the real Shared sink", async () => {
  for (const method of ["GET", "PUT"]) {
    const records: LogRecord[] = [];
    const databaseError = new Prisma.PrismaClientKnownRequestError("Original foreign-key failure while saving offers", {
      code: "P2003", clientVersion: "test",
    });
    const wrapped = new DiscountOffersError(409, "offers_conflict", { cause: databaseError });
    const f = harness(method, "/v1/merchant/discount-offers",
      method === "PUT" ? { recoveryOfferMode: "FIXED", selectedDiscountIds: ["coupon-one"] } : undefined,
      false, wrapped, createLogger({ serviceName: "api006-discounts-test", environment: "test",
        sink: record => records.push(record) }));
    await f.route.handle(f.request, f.response);
    assert.equal(f.output.status, 409);
    assert.deepEqual(f.output.body, { error: "offers_conflict" });
    assert.equal(f.output.headers?.["cache-control"], "no-store");
    assert.equal(records.length, 1);
    assert.equal(records[0]!.event, "merchant.discount_offers.access.denied");
    assert.equal(records[0]!.data?.databaseCode, "P2003");
    assert.deepEqual(records[0]!.data?.errorCause, { name: databaseError.name, message: databaseError.message });
    assert.equal(records[0]!.data?.redactionApplied, false);
    assert.equal(wrapped.cause, databaseError);
    assert.ok(!JSON.stringify(f.output.body).includes(databaseError.message));
  }
});

test("discount diagnostics redact sensitive causes with Shared bounds and no public details", async () => {
  const records: LogRecord[] = [];
  const original = "Original foreign-key failure; redis://reader:db-password@private/0 " +
    "Bearer bearer-value; token=token-value; credential=credential-value; user@example.invalid +447700900123";
  const databaseError = new Prisma.PrismaClientKnownRequestError(original, {
    code: "P2003", clientVersion: "test",
    meta: { query: "SELECT customer-body", secret: "meta-value", payload: { customer: "customer-value" } },
  });
  const wrapped = new DiscountOffersError(409, "offers_conflict", { cause: databaseError });
  const f = harness("PUT", "/v1/merchant/discount-offers",
    { recoveryOfferMode: "FIXED", selectedDiscountIds: ["coupon-one"] }, false, wrapped,
    createLogger({ serviceName: "api006-discounts-test", environment: "test",
      sink: record => records.push(record) }));
  await f.route.handle(f.request, f.response);
  const privateLog = JSON.stringify(records);
  for (const sensitive of ["redis://", "db-password", "bearer-value", "token-value", "credential-value",
    "user@example.invalid", "447700900123", "customer-body", "meta-value", "customer-value"]) {
    assert.equal(privateLog.includes(sensitive), false, sensitive);
  }
  assert.ok(privateLog.includes("Original foreign-key failure"));
  assert.equal(records[0]!.data?.databaseCode, "P2003");
  assert.equal(records[0]!.data?.redactionApplied, true);
  assert.deepEqual(f.output.body, { error: "offers_conflict" });
  assert.equal(databaseError.message, original);
  assert.equal(wrapped.cause, databaseError);

  const boundedRecords: LogRecord[] = [];
  const longError = new Error("x".repeat(LOG_VALUE_LIMITS.maxStringLength - 8) + " token=" + "boundary-value".repeat(100));
  const bounded = harness("GET", "/v1/merchant/discount-offers", undefined, false, longError,
    createLogger({ serviceName: "api006-discounts-test", environment: "test",
      sink: record => boundedRecords.push(record) }));
  await bounded.route.handle(bounded.request, bounded.response);
  assert.equal(bounded.output.status, 500);
  assert.deepEqual(bounded.output.body, { error: "internal_error" });
  assert.equal(JSON.stringify(boundedRecords).includes("boundary-value"), false);
  const error = boundedRecords[0]!.data?.error as { message: string };
  assert.ok(error.message.length <= LOG_VALUE_LIMITS.maxStringLength + 20);
  assert.equal(boundedRecords[0]!.data?.databaseCode, undefined);
  assert.equal(boundedRecords[0]!.data?.errorCause, undefined);
});

test("unwrapped Prisma conflicts keep their database evidence and original public response", async () => {
  const records: LogRecord[] = [];
  const databaseError = new Prisma.PrismaClientKnownRequestError("Original unwrapped serialization failure", {
    code: "P2034", clientVersion: "test",
  });
  const f = harness("GET", "/v1/merchant/discount-offers", undefined, false, databaseError,
    createLogger({ serviceName: "api006-discounts-test", environment: "test",
      sink: record => records.push(record) }));
  await f.route.handle(f.request, f.response);
  assert.equal(f.output.status, 409);
  assert.deepEqual(f.output.body, { error: "offers_conflict" });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.data?.databaseCode, "P2034");
  assert.deepEqual(records[0]!.data?.error, { name: databaseError.name, message: databaseError.message });
  assert.equal(records[0]!.data?.errorCause, undefined);
});


test("discount-offers Prisma multiline diagnostics retain failure reasons without invocation/customer context", async () => {
  const foreignKey = "Foreign key constraint violated on the constraint: safe_fk_constraint";
  const transaction = "Transaction failed due to a write conflict or a deadlock. Please retry your transaction";
  const fixtures = [
    { code: "P2003", reason: foreignKey, message: [
      "", "Invalid `prisma.example.update()` invocation:", "", "{", "  data: {",
      '    customerName: "Private Shopper",', '    customerAddress: "Private Street",',
      '    token: "invocation-value",', '    email: "customer@example.invalid",',
      '    misleading: "Foreign key constraint violated on the constraint: private-fake-constraint",',
      '    notes: "' + "private-argument".repeat(LOG_VALUE_LIMITS.maxStringLength) + '",',
      "  }", "}", "", foreignKey,
    ].join("\n") },
    { code: "P2034", reason: transaction, message: [
      "", "Invalid `prisma.example.update()` invocation in", "/private/customer-source.ts:42:17", "",
      '  39 const customerName = "Private Shopper";',
      '  40 const customerAddress = "Private Street";',
      '  41 const token = "invocation-value"; // Transaction failed due to a write conflict or a deadlock: private-fake-constraint',
      "→ 42 await prisma.example.update(", transaction,
    ].join("\n") },
    { code: "P2003", reason: foreignKey, message:
      "\nInvalid `prisma.example.update()` invocation:\n\n\n" + foreignKey },
    { code: "P2002", reason: "Unique constraint failed on the fields: (`safe_unique_field`)", message:
      "\nInvalid `prisma.example.update()` invocation:\r\n\r\n" +
      "Unique constraint failed on the fields: (`safe_unique_field`)\r\n" },
    { code: "P2003", reason: foreignKey, message: [
      "", "Invalid `prisma.example.update()` invocation in", "/private/customer-source.ts:42:17", "",
      '  41 const customerName = "Private Shopper";', "→ 42 await prisma.example.update(", foreignKey,
    ].join("\n") },
    { code: "P2003", reason: foreignKey, message: [
      "", "Invalid `prisma.example.update()` invocation in", "/private/customer-source.ts:42:17", "",
      '  41 const customerName = "Private Shopper";', "→ 42 await prisma.example.update({",
      '       data: { customerName: "Private Shopper", token: "invocation-value" }',
      "})", "", foreignKey,
    ].join("\n") },
    // A safe-looking line inside an unfinished rendering is not an origin reason.
    { code: "P2003", reason: undefined, message:
      '\nInvalid `prisma.example.update()` invocation:\n\n{ data: {\n' +
      'Foreign key constraint violated on the constraint: private-fake-constraint' },
    // No database description: do not mistake the invocation for a failure reason.
    { code: "P2003", reason: undefined, message:
      '\nInvalid `prisma.example.update()` invocation:\n\n{ customerName: "Private Shopper", token: "invocation-value" }' },
  ];
  for (const method of ["GET", "PUT"]) {
    for (const fixture of fixtures) {
      const records: LogRecord[] = [];
      const databaseError = new Prisma.PrismaClientKnownRequestError(fixture.message, {
        code: fixture.code, clientVersion: "6.19.3",
        meta: { query: "SELECT private-query", payload: { customer: "private-payload" } },
      });
      databaseError.stack = "private-stack";
      const wrapped = new DiscountOffersError(409, "offers_conflict", { cause: databaseError });
      const f = harness(method, "/v1/merchant/discount-offers",
        method === "PUT" ? { recoveryOfferMode: "FIXED", selectedDiscountIds: ["coupon-one"] } : undefined,
        false, wrapped, createLogger({ serviceName: "api006-discounts-test", environment: "test",
          sink: record => records.push(record) }));
      await f.route.handle(f.request, f.response);
      assert.equal(f.output.status, 409);
      assert.deepEqual(f.output.body, { error: "offers_conflict" });
      assert.equal(f.output.headers?.["cache-control"], "no-store");
      assert.equal(records.length, 1);
      assert.equal(records[0]!.data?.databaseCode, fixture.code);
      assert.equal(records[0]!.data?.redactionApplied, true);
      const cause = records[0]!.data?.errorCause as { name: string; message: string };
      assert.equal(cause.name, databaseError.name);
      if (fixture.reason) assert.ok(cause.message.includes(fixture.reason), cause.message);
      else assert.equal(cause.message.trim(), "[REDACTED]");
      const privateLog = JSON.stringify(records);
      for (const sensitive of ["Private Shopper", "Private Street", "invocation-value", "customer@example.invalid",
        "private-argument", "private-fake-constraint", "customer-source.ts", "private-query", "private-payload", "private-stack", "prisma.example"]) {
        assert.equal(privateLog.includes(sensitive), false, sensitive);
      }
      assert.equal(databaseError.message, fixture.message);
      assert.equal(wrapped.cause, databaseError);
    }
  }
});
