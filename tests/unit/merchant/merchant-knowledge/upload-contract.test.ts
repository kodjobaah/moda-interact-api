import assert from "node:assert/strict";
import test from "node:test";
import { deterministicAssetId, parseEdit, parseFinalize, parseIntent, wooObjectKey } from "../../../../src/merchant/merchant-knowledge/upload-contract.js";
import { loadUploadR2Configuration } from "../../../../src/merchant/merchant-knowledge/upload-r2.js";

const valid = { idempotencyKey: "550e8400-e29b-41d4-a716-446655440000", purposeKey: "FAQ", dataFormatKey: "CSV",
  originalFileName: "faqs.csv", contentType: "text/csv", sizeBytes: 100, sha256: "a".repeat(64) };
test("strict upload contract rejects untrusted identity/unknown fields, MIME, filename, size and hash", () => {
  assert.deepEqual(parseIntent(valid), valid);
  for (const modified of [ { shopId: "foreign" }, { objectKey: "foreign" }, { originalFileName: "../faqs.csv" },
    { contentType: "image/jpeg" }, { contentType: "text/csv; charset=utf-8" },
    { dataFormatKey: "WEB_PAGE" }, { sizeBytes: 0 }, { sha256: "bad" }, { idempotencyKey: "not-uuid" } ]) {
    const candidate = { ...valid, ...modified };
    if (modified.contentType === "image/jpeg") {
      assert.equal(parseIntent(candidate).contentType, "image/jpeg"); // catalogue entitlement rejects unaccepted type
    } else assert.throws(() => parseIntent(candidate));
  }
  assert.throws(() => parseFinalize({ ...valid, assetId: "asset", name: "Name", languageTag: "en", idempotencyKey: valid.idempotencyKey }));
  assert.deepEqual(parseFinalize({ assetId: "asset", name: "Name", languageTag: "en", purposeKey: "FAQ",
    contentType: "text/csv", sha256: "a".repeat(64), sizeBytes: 100 }), {
    assetId: "asset", name: "Name", languageTag: "en", purposeKey: "FAQ",
    contentType: "text/csv", sha256: "a".repeat(64), sizeBytes: 100,
  });
  assert.deepEqual(parseEdit({ name: "FAQ", languageTag: "en" }), { name: "FAQ", languageTag: "en" });
  assert.throws(() => parseEdit({ name: "FAQ", languageTag: "en", shopId: "foreign" }));
});
test("R2 object key never includes merchant-provided domain or filename", () => {
  const asset = deterministicAssetId("shop_abc", valid.idempotencyKey);
  assert.match(asset, /^[0-9a-f-]{36}$/);
  assert.equal(asset, deterministicAssetId("shop_abc", valid.idempotencyKey));
  assert.notEqual(asset, deterministicAssetId("shop_other", valid.idempotencyKey));
  assert.equal(wooObjectKey("development", "shop_abc", asset, "CSV"),
    `merchant-knowledge/development/woocommerce/shop_abc/${asset}/source.csv`);
  for (const invalid of ["a/b", "../", "", "localhost.example", "evil\\domain"]) {
    assert.throws(() => wooObjectKey("development", invalid, asset, "CSV"));
  }
});
test("upload R2 configuration fails closed without Cloudflare HTTPS and bounded limit", () => {
  const env = { MERCHANT_KNOWLEDGE_R2_BUCKET: "knowledge-bucket",
    MERCHANT_KNOWLEDGE_R2_ENDPOINT: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
    MERCHANT_KNOWLEDGE_R2_ACCESS_KEY_ID: "key", MERCHANT_KNOWLEDGE_R2_SECRET_ACCESS_KEY: "secret",
    MERCHANT_KNOWLEDGE_MAX_UPLOAD_BYTES: "5242880" };
  assert.equal(loadUploadR2Configuration(env).maxUploadBytes, 5242880);
  for (const endpoint of ["http://localhost", "https://127.0.0.1", "https://evil.example", `https://${"a".repeat(32)}.r2.cloudflarestorage.com:444`])
    assert.throws(() => loadUploadR2Configuration({ ...env, MERCHANT_KNOWLEDGE_R2_ENDPOINT: endpoint }));
  assert.throws(() => loadUploadR2Configuration({ ...env, MERCHANT_KNOWLEDGE_R2_SECRET_ACCESS_KEY: "" }));
  assert.throws(() => loadUploadR2Configuration({ ...env, MERCHANT_KNOWLEDGE_MAX_UPLOAD_BYTES: "99999999999" }));
});
