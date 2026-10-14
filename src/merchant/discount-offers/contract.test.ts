import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { parseSaveDiscountOffers, readCatalogueQuery, offerRevision } from "./contract.js";

test("Woo coupon contract bounds multi-selection and enforces FIXED nonempty selection", () => {
  assert.deepEqual(parseSaveDiscountOffers({recoveryOfferMode:"FIXED",
    selectedDiscountIds:["coupon-1","coupon-2"]}).selectedDiscountIds,["coupon-1","coupon-2"]);
  assert.throws(()=>parseSaveDiscountOffers({recoveryOfferMode:"FIXED",selectedDiscountIds:[]}));
  assert.throws(()=>parseSaveDiscountOffers({recoveryOfferMode:"NONE",selectedDiscountIds:["one","one"]}));
  assert.throws(()=>parseSaveDiscountOffers({recoveryOfferMode:"FIXED",
    selectedDiscountIds:Array.from({length:51},(_,i)=>`id-${i}`)}));
  assert.throws(()=>parseSaveDiscountOffers({recoveryOfferMode:"NONE",selectedDiscountIds:[],shopId:"foreign"}));
  // The old revision precondition is no longer part of the API Save contract.
  assert.throws(()=>parseSaveDiscountOffers({expectedRevision:"abc",recoveryOfferMode:"NONE",selectedDiscountIds:[]}));
  assert.deepEqual(readCatalogueQuery(new URLSearchParams("limit=10&search=WELCOME")),{limit:10,search:"WELCOME"});
  assert.throws(()=>readCatalogueQuery(new URLSearchParams("limit=500")));
  assert.throws(()=>readCatalogueQuery(new URLSearchParams("limit=10&limit=30")));
});

test("GET response revision is informational and never required by Save", () => {
  const catalogue={status:"CURRENT",syncGeneration:2,updatedAt:new Date("2026-10-14T00:00:00Z")};
  const rev=offerRevision(null,catalogue);
  assert.notEqual(rev,offerRevision(new Date("2026-10-14T00:00:00Z"),catalogue));
  assert.notEqual(rev,offerRevision(null,{...catalogue,syncGeneration:3}));
  assert.notEqual(rev,offerRevision(null,{...catalogue,status:"ERROR"}));
  assert.notEqual(rev,offerRevision(null,{...catalogue,updatedAt:new Date("2026-10-14T00:00:01Z")}));
  assert.equal(typeof offerRevision(null,null),"string");
});

test("versioned hosted API contract contains exact Woo-only endpoints", () => {
  const spec=parse(readFileSync(new URL("../../../openapi/woocommerce-discount-offers-v1.yaml",import.meta.url),"utf8")) as {
    openapi:string; paths:Record<string,Record<string,unknown>>;
    components:{schemas:{DiscountOffersSave:{additionalProperties:boolean;required:string[]}}};
  };
  assert.equal(spec.openapi,"3.1.0");
  assert.deepEqual(Object.keys(spec.paths),["/v1/merchant/discount-catalogue","/v1/merchant/discount-offers"]);
  assert.deepEqual(Object.keys(spec.paths["/v1/merchant/discount-offers"]??{}),["get","put"]);
  assert.equal(spec.components.schemas.DiscountOffersSave.additionalProperties,false);
  assert.deepEqual([...spec.components.schemas.DiscountOffersSave.required].sort(),[
    "recoveryOfferMode","selectedDiscountIds"].sort());
  const str=JSON.stringify(spec);
  for(const secret of ["consumerSecret", "credentialCiphertext", "apiKey", "shopId:"]) assert.ok(!str.includes(secret));
});
