import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { KNOWLEDGE_UPLOAD_FINALIZE_PATH, KNOWLEDGE_UPLOAD_INTENTS_PATH } from "../../../../src/merchant/merchant-knowledge/upload-contract.js";
import { createMerchantKnowledgeUploadRoutes } from "../../../../src/merchant/merchant-knowledge/upload.routes.js";
import { normaliseUploadError } from "../../../../src/merchant/merchant-knowledge/upload.service.js";

const principal = { shopId: "shop-tenant-a", installationId: "installation-a",
  canonicalSiteUrl: "https://woo.example.test", credentialVersion: 3 };
const body = { idempotencyKey: "550e8400-e29b-41d4-a716-446655440000", purposeKey: "PRODUCT_INFORMATION",
  dataFormatKey: "CSV", originalFileName: "products.csv", contentType: "text/csv", sizeBytes: 20, sha256: "a".repeat(64) };
const capability = `https://${"a".repeat(32)}.r2.cloudflarestorage.com/bucket/object` +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=private-signed-query";
const intent = { schemaVersion: 1, assetId: "asset-a", uploadUrl: capability,
  expiresAt: "2026-10-18T17:20:00.000Z", maxUploadBytes: 1024,
  requiredHeaders: { "Content-Type": "text/csv", "If-None-Match": "*", "x-amz-meta-sha256": "a".repeat(64) } };

function setup(options: { fail?: boolean } = {}) {
  const logs: Array<{ name: string; data: unknown }> = [];
  const calls: Array<{ operation: string; shopId: string }> = [];
  const routes = createMerchantKnowledgeUploadRoutes({
    authenticator: { async authenticate(request: { headers: Record<string, string | undefined> }) {
      if (request.headers.authorization !== "Bearer authenticated-secret" ||
          request.headers["x-moda-installation-id"] !== principal.installationId) throw new WooUnauthenticatedError();
      return principal;
    } } as never,
    service: {
      async intent(p: typeof principal) {
        calls.push({ operation: "intent", shopId: p.shopId });
        if (options.fail) throw new Error(`provider failed: ${capability} credential=never-log`);
        return intent;
      },
      async finalize(p: typeof principal) {
        calls.push({ operation: "finalize", shopId: p.shopId });
        return { schemaVersion: 1, sourceId: "source-a", revisionId: "revision-a", generation: 1, status: "ACCEPTED" };
      },
      async reprocess(p: typeof principal, sourceId: string) {
        assert.equal(sourceId, "file_1");
        calls.push({ operation: "reprocess", shopId: p.shopId });
        return { schemaVersion: 1, sourceId: "file_1", revisionId: "revision_2", generation: 2, status: "ACCEPTED" };
      },
    } as never,
    logger: { info(name: string, data: unknown) { logs.push({ name, data }); },
      warn(name: string, data: unknown) { logs.push({ name, data }); } } as never,
  });
  return { routes, logs, calls };
}
async function withRoutes(
  routes: ReturnType<typeof createMerchantKnowledgeUploadRoutes>, callback: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((matched) => {
      if (!matched) { response.writeHead(404); response.end(); }
    }).catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
function headers(authorized = true) {
  return { "Content-Type": "application/json", "X-Moda-Installation-Id": principal.installationId,
    ...(authorized ? { Authorization: "Bearer authenticated-secret" } : {}) };
}
function noStore(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
}

test("unexpected upstream upload errors normalise to bounded 503 without reflecting secrets", () => {
  const failure = normaliseUploadError(new Error(`provider failed: ${capability} credential=never-log`));
  assert.equal(failure.status, 503);
  assert.equal(failure.code, "knowledge_upload_unavailable");
  assert.equal(failure.message.includes("X-Amz-Signature"), false);
  assert.equal(failure.message.includes("never-log"), false);
});

test("only the authenticated installation receives the opaque signed capability; response is no-store", async () => {
  const state = setup();
  await withRoutes(state.routes, async (base) => {
    const denied = await fetch(`${base}${KNOWLEDGE_UPLOAD_INTENTS_PATH}`, { method: "POST",
      headers: { ...headers(false), Origin: "https://attacker.example.test" }, body: JSON.stringify(body) });
    assert.equal(denied.status, 401); noStore(denied);
    assert.deepEqual(await denied.json(), { error: "unauthorized" });
    const success = await fetch(`${base}${KNOWLEDGE_UPLOAD_INTENTS_PATH}`, { method: "POST",
      headers: headers(), body: JSON.stringify(body), cache: "no-store" });
    assert.equal(success.status, 200); noStore(success);
    assert.deepEqual(await success.json(), intent);
    const spoofedShop = await fetch(`${base}${KNOWLEDGE_UPLOAD_INTENTS_PATH}`, { method: "POST",
      headers: headers(), body: JSON.stringify({ ...body, shopId: "other-tenant" }) });
    assert.equal(spoofedShop.status, 400); noStore(spoofedShop);
    assert.deepEqual(await spoofedShop.json(), { error: "invalid_request" });
    const query = await fetch(`${base}${KNOWLEDGE_UPLOAD_INTENTS_PATH}?shopId=other-tenant`, {
      method: "POST", headers: headers(), body: JSON.stringify(body) });
    assert.equal(query.status, 400); noStore(query);
    assert.deepEqual(await query.json(), { error: "invalid_request" });
  });
  assert.deepEqual(state.calls, [{ operation: "intent", shopId: principal.shopId }]);
  assert.equal(JSON.stringify(state.logs).includes("X-Amz-Signature"), false);
  assert.equal(JSON.stringify(state.logs).includes(body.sha256), false);
  assert.equal(JSON.stringify(state.logs).includes("authenticated-secret"), false);
  assert.deepEqual(state.logs, [{ name: "merchant.knowledge.upload", data: { shopId: principal.shopId, operation: "intent" } }]);
});

test("only authenticated metadata finalize is accepted; malformed or upstream errors stay bounded and no-store", async () => {
  const state = setup({ fail: true });
  const finalization = { assetId: "asset-a", purposeKey: body.purposeKey, name: "Catalogue", languageTag: "en",
    contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 };
  await withRoutes(state.routes, async (base) => {
    const failure = await fetch(`${base}${KNOWLEDGE_UPLOAD_INTENTS_PATH}`, { method: "POST",
      headers: headers(), body: JSON.stringify(body) });
    assert.equal(failure.status, 503); noStore(failure);
    assert.deepEqual(await failure.json(), { error: "knowledge_upload_unavailable" });
    const finalize = await fetch(`${base}${KNOWLEDGE_UPLOAD_FINALIZE_PATH}`, { method: "POST",
      headers: headers(), body: JSON.stringify(finalization) });
    assert.equal(finalize.status, 200); noStore(finalize);
    assert.deepEqual(await finalize.json(), { schemaVersion: 1, sourceId: "source-a", revisionId: "revision-a",
      generation: 1, status: "ACCEPTED" });
    const malicious = await fetch(`${base}${KNOWLEDGE_UPLOAD_FINALIZE_PATH}`, { method: "POST",
      headers: headers(), body: JSON.stringify({ ...finalization, objectKey: "other-tenant" }) });
    assert.equal(malicious.status, 400); noStore(malicious);
    assert.deepEqual(await malicious.json(), { error: "invalid_request" });
  });
  assert.deepEqual(state.calls, [{ operation: "intent", shopId: principal.shopId },
    { operation: "finalize", shopId: principal.shopId }]);
  assert.deepEqual(state.logs, [
    { name: "merchant.knowledge.upload.failed", data: { reason: "knowledge_upload_unavailable" } },
    { name: "merchant.knowledge.upload", data: { shopId: principal.shopId, operation: "finalize" } },
  ]);
  assert.equal(JSON.stringify(state.logs).includes(capability), false);
  assert.equal(JSON.stringify(state.logs).includes("never-log"), false);
});

test("bodyless reprocess accepts harmless transport headers but rejects actual request bytes", async () => {
  const state = setup();
  await withRoutes(state.routes, async (base) => {
    const path = `${base}/v1/merchant/merchant-knowledge/uploads/file_1/reprocess`;
    const accepted = await fetch(path, { method: "POST", headers: headers() });
    assert.equal(accepted.status, 200); noStore(accepted);
    assert.deepEqual(await accepted.json(), { schemaVersion: 1, sourceId: "file_1",
      revisionId: "revision_2", generation: 2, status: "ACCEPTED" });
    const rejected = await fetch(path, { method: "POST", headers: headers(), body: "{}" });
    assert.equal(rejected.status, 400); noStore(rejected);
    assert.deepEqual(await rejected.json(), { error: "invalid_request" });
  });
  assert.deepEqual(state.calls, [{ operation: "reprocess", shopId: principal.shopId }]);
});
