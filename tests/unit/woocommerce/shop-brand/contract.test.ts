import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  MAX_WOO_SHOP_BRAND_BYTES, parseWooShopBrandSnapshot, WooShopBrandHttpError,
} from "../../../../src/woocommerce/shop-brand/contract.js";
import { readWooShopBrandRequest } from "../../../../src/woocommerce/shop-brand/request.js";
import { wooImageSource } from "../../../../src/woocommerce/shop-brand/service.js";

const example = () => ({
  schemaVersion: "woo.shop-brand.v1", eventId: "snapshot.1",
  observedAt: "2026-10-27T09:00:00Z", brandName: "  Boutique 🛍️  ",
  logo: { url: "https://woo.example/wp-content/logo.png", attachmentId: 123,
    altText: " Boutique logo ", width: 1200, height: 400 },
  siteIcon: { url: "https://woo.example/wp-content/icon.png", attachmentId: 456,
    altText: null, width: 512, height: 512 },
  coverImage: null,
});
const isInvalid = (error: unknown) => error instanceof WooShopBrandHttpError && error.status === 400;

test("decodes exact Woo snapshot and canonical UTC observation, preserving source URLs", () => {
  const value = parseWooShopBrandSnapshot(example());
  assert.equal(value.brandName, "Boutique 🛍️");
  assert.equal(value.observedAt, "2026-10-27T09:00:00.000Z");
  assert.equal(value.logo?.altText, "Boutique logo");
  assert.equal(value.logo?.url, example().logo.url);
  assert.equal(value.coverImage, null);
  assert.deepEqual(parseWooShopBrandSnapshot({ ...example(), brandName: " " }).brandName, null);
  assert.equal(parseWooShopBrandSnapshot({ ...example(), logo: null }).logo, null);
  assert.equal(parseWooShopBrandSnapshot({ ...example(), logo: {
    url: null, attachmentId: 123, altText: null, width: null, height: null,
  } }).logo?.url, null);
});

test("rejects forged tenant, partial or extended payload and invalid media metadata", () => {
  const invalid = [
    { ...example(), shopId: "other-shop" }, { ...example(), installationId: "other" },
    { ...example(), coverImage: undefined }, { ...example(), schemaVersion: "woo.shop-brand.v2" },
    { ...example(), observedAt: "2026-10-27T09:00:00+01:00" },
    { ...example(), observedAt: "2026-02-30T09:00:00Z" },
    { ...example(), observedAt: "garbage" },
    { ...example(), eventId: "invalid\nheader" },
    { ...example(), brandName: "x".repeat(161) },
    { ...example(), logo: { ...example().logo, attachmentId: 0 } },
    { ...example(), logo: { ...example().logo, attachmentId: 1.5 } },
    { ...example(), logo: { ...example().logo, width: 0 } },
    { ...example(), logo: { ...example().logo, url: "http://woo.example/logo.png" } },
    { ...example(), logo: { ...example().logo, url: "https://user:pass@woo.example/logo.png" } },
    { ...example(), logo: { ...example().logo, url: "https://woo.example/image.png#fragment" } },
    { ...example(), logo: { ...example().logo, url: "https://woo.example/" + "x".repeat(2100) } },
    { ...example(), logo: { ...example().logo, unsupported: true } },
    { ...example(), logo: { ...example().logo, altText: "\ud800" } },
  ];
  for (const value of invalid) assert.throws(() => parseWooShopBrandSnapshot(value), isInvalid);
});

test("source fingerprint changes with URL/attachment, not label/size, and is null on removal", () => {
  const logo = parseWooShopBrandSnapshot(example()).logo!;
  const base = wooImageSource(logo);
  assert.match(base.fingerprint!, /^sha256:[a-f0-9]{64}$/);
  assert.equal(base.reference, "woocommerce:attachment:123");
  assert.deepEqual(wooImageSource({ ...logo, altText: "New label", width: 33 }), base);
  assert.notEqual(wooImageSource({ ...logo, attachmentId: 124 }).fingerprint, base.fingerprint);
  assert.notEqual(wooImageSource({ ...logo, url: "https://woo.example/other.png" }).fingerprint, base.fingerprint);
  assert.deepEqual(wooImageSource({ ...logo, url: null }), { url: null, reference: null, fingerprint: null });
});

function stream(body: string, rawHeaders: string[]): IncomingMessage {
  const request = new PassThrough() as PassThrough & IncomingMessage;
  request.rawHeaders = rawHeaders;
  queueMicrotask(() => request.end(Buffer.from(body, "utf8")));
  return request;
}
const json = ["Content-Type", "application/json"];

test("16 KiB is inclusive and oversized encoded body is rejected", async () => {
  await assert.rejects(readWooShopBrandRequest(stream(" ".repeat(MAX_WOO_SHOP_BRAND_BYTES + 1), json)),
    (e: unknown) => e instanceof WooShopBrandHttpError && e.status === 413);
  await assert.rejects(readWooShopBrandRequest(stream(JSON.stringify(example()), [
    ...json, "Content-Length", String(MAX_WOO_SHOP_BRAND_BYTES + 1),
  ])), (e: unknown) => e instanceof WooShopBrandHttpError && e.status === 413);
});

test("rejects duplicate headers, duplicate JSON keys, gzip, invalid UTF-8 and missing content type", async () => {
  const body = JSON.stringify(example());
  for (const headers of [
    [...json, "CONTENT-TYPE", "application/json"],
    [...json, "Authorization", "Bearer a", "authorization", "Bearer b"],
    [...json, "Content-Encoding", "gzip"],
    [...json, "Content-Length", "123", "Transfer-Encoding", "chunked"],
    ["Accept", "application/json"],
  ]) await assert.rejects(readWooShopBrandRequest(stream(body, headers)), isInvalid);
  const duplicate = body.replace('"eventId":"snapshot.1"',
    '"eventId":"snapshot.1","eventId":"snapshot.2"');
  await assert.rejects(readWooShopBrandRequest(stream(duplicate, json)), isInvalid);
  const escapedDuplicate = body.replace('"eventId":"snapshot.1"',
    '"eventId":"snapshot.1","even\\u0074Id":"snapshot.2"');
  await assert.rejects(readWooShopBrandRequest(stream(escapedDuplicate, json)), isInvalid);
  const nonUtf8 = new PassThrough() as PassThrough & IncomingMessage;
  nonUtf8.rawHeaders = json;
  const promise = readWooShopBrandRequest(nonUtf8);
  nonUtf8.end(Buffer.from([0xff, 0xfe]));
  await assert.rejects(promise, isInvalid);
  const got = await readWooShopBrandRequest(stream(body, json));
  assert.equal(got.eventId, "snapshot.1");
});
