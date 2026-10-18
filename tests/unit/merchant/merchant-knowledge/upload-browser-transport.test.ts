import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createUploadR2 } from "../../../../src/merchant/merchant-knowledge/upload-r2.js";
import { verifyPresignedBrowserPut } from "../../../fixtures/merchant-knowledge/verify-presigned-put.js";

const origin = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const credentials = { accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" };
const config = { endpoint: origin, bucket: "knowledge-fixture", ...credentials, maxUploadBytes: 2048 };
const browserOrigin = "https://shop.example.test";
const csv = new Blob(["sku,name\n12,Cup\n"], { type: "text/csv" });
const bytes = Buffer.from("sku,name\n12,Cup\n");
const digest = createHash("sha256").update(bytes).digest("hex");
const requiredHeaders = { "Content-Type": "text/csv", "If-None-Match": "*", "x-amz-meta-sha256": digest };
const objectKey = "merchant-knowledge/test/woocommerce/shop-1/00000000-0000-5000-a000-000000000001/source.csv";

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  callback: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((request, response) => {
    void handler(request, response).catch(() => { response.writeHead(500); response.end(); });
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

/** Node fetch transmits a Blob and the browser-permitted signed headers over real HTTP.
 * OPTIONS is deliberately simulated and asserted: Node does NOT enforce browser CORS.
 */
test("browser-like Blob PUT uses exactly signed headers, explicit preflight policy and one-use R2 semantics", async () => {
  const signedUrl = await createUploadR2(config).sign({ key: objectKey, contentType: "text/csv", sha256: digest, expiresIn: 300 });
  const url = new URL(signedUrl);
  assert.equal(url.origin, origin);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  // In SDK v3, WHEN_SUPPORTED may attach a CRC32 for the empty presigning
  // request. That checksum must NOT be included for an unknown future Blob.
  assert.equal(url.searchParams.has("x-amz-checksum-crc32"), false);
  assert.equal(url.searchParams.has("x-amz-sdk-checksum-algorithm"), false);
  assert.deepEqual(url.searchParams.get("X-Amz-SignedHeaders")?.split(";"),
    ["content-type", "host", "if-none-match", "x-amz-meta-sha256"]);
  const received: string[] = [];
  let stored: Buffer | undefined;
  await withServer(async (request, response) => {
    const headers = new Headers(request.headers as Record<string, string>);
    if (request.method === "OPTIONS") {
      received.push("OPTIONS");
      if (request.headers.origin !== browserOrigin) {
        response.writeHead(403); response.end(); return;
      }
      assert.equal(request.headers["access-control-request-method"], "PUT");
      assert.equal(request.headers["access-control-request-headers"], "content-type,if-none-match,x-amz-meta-sha256");
      response.writeHead(204, { "Access-Control-Allow-Origin": browserOrigin,
        "Access-Control-Allow-Methods": "PUT", "Access-Control-Allow-Headers": "content-type,if-none-match,x-amz-meta-sha256",
        Vary: "Origin" });
      response.end();
      return;
    }
    received.push("PUT");
    assert.equal(request.method, "PUT");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers["x-moda-installation-id"], undefined);
    assert.equal(request.headers["x-wp-nonce"], undefined);
    const reply = (status: number) => {
      response.writeHead(status, { "Access-Control-Allow-Origin": browserOrigin, Vary: "Origin" });
      response.end();
    };
    const mapped = new URL(`https://${url.host}${request.url ?? "/"}`);
    if (!verifyPresignedBrowserPut({ signedUrl: mapped.toString(), requestHeaders: headers, ...credentials, at: new Date() })) {
      reply(403); return;
    }
    if (stored) { reply(412); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    stored = Buffer.concat(chunks);
    reply(200);
  }, async (base) => {
    const mapped = `${base}${url.pathname}${url.search}`;
    const preflight = await fetch(mapped, { method: "OPTIONS", headers: { Origin: browserOrigin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type,if-none-match,x-amz-meta-sha256" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), browserOrigin);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "PUT");
    const otherOrigin = await fetch(mapped, { method: "OPTIONS", headers: {
      Origin: "https://not-enrolled.example.test", "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type,if-none-match,x-amz-meta-sha256",
    } });
    assert.equal(otherOrigin.status, 403);
    assert.equal(otherOrigin.headers.get("access-control-allow-origin"), null);
    const options = { method: "PUT", body: csv, headers: requiredHeaders, credentials: "omit", redirect: "error" } as const;
    const put = await fetch(mapped, options);
    assert.equal(put.status, 200);
    assert.equal(put.headers.get("access-control-allow-origin"), browserOrigin);
    const replay = await fetch(mapped, options);
    assert.equal(replay.status, 412);
    const corrupted = await fetch(mapped, { ...options, headers: { ...requiredHeaders, "If-None-Match": "false" } });
    assert.equal(corrupted.status, 403);
    const missingHash = await fetch(mapped, { ...options, headers: {
      "Content-Type": requiredHeaders["Content-Type"], "If-None-Match": "*" } });
    assert.equal(missingHash.status, 403);
    const tampered = new URL(mapped);
    tampered.searchParams.set("X-Amz-Signature", "0".repeat(64));
    const tamperedResult = await fetch(tampered, options);
    assert.equal(tamperedResult.status, 403);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(fetch(mapped, { ...options, signal: cancelled.signal }));
  });
  assert.deepEqual(stored, bytes);
  assert.deepEqual(received, ["OPTIONS", "OPTIONS", "PUT", "PUT", "PUT", "PUT", "PUT"]);
});

test("signed PUT rejects expired and tampered signed host/path even with correct body/headers", async () => {
  const signedUrl = await createUploadR2(config).sign({ key: objectKey, contentType: "text/csv", sha256: digest, expiresIn: 60 });
  const at = new Date();
  assert.equal(verifyPresignedBrowserPut({ signedUrl, requestHeaders: new Headers(requiredHeaders), ...credentials, at }), true);
  const expire = new Date(at.getTime() + 61_000);
  assert.equal(verifyPresignedBrowserPut({ signedUrl, requestHeaders: new Headers(requiredHeaders), ...credentials, at: expire }), false);
  const changedPath = new URL(signedUrl); changedPath.pathname += "-other";
  assert.equal(verifyPresignedBrowserPut({ signedUrl: changedPath.toString(), requestHeaders: new Headers(requiredHeaders), ...credentials, at }), false);
  const changedHost = new URL(signedUrl); changedHost.hostname = `${"b".repeat(32)}.r2.cloudflarestorage.com`;
  assert.equal(verifyPresignedBrowserPut({ signedUrl: changedHost.toString(), requestHeaders: new Headers(requiredHeaders), ...credentials, at }), false);
});

test("redirect is an upload error: browser-like fetch never forwards signed URL or body to redirected host", async () => {
  let redirectedPut = 0;
  await withServer(async (request, response) => {
    if (request.url === "/redirected") { redirectedPut++; response.writeHead(200); response.end(); return; }
    response.writeHead(307, { Location: "/redirected" }); response.end();
  }, async (base) => {
    await assert.rejects(fetch(`${base}/start`, { method: "PUT", body: csv,
      headers: requiredHeaders, credentials: "omit", redirect: "error" }));
  });
  assert.equal(redirectedPut, 0);
});

test("accepted PUT status alone cannot activate a wrong-byte object: finalize must hash the GET body", async () => {
  const client = new S3Client({ endpoint: origin, region: "auto", forcePathStyle: true, credentials });
  const wrong = Buffer.from("sku,name\n12,Lid\n");
  client.send = (async (command: unknown) => command instanceof HeadObjectCommand
    ? { ContentLength: bytes.length, ContentType: "text/csv", Metadata: { sha256: digest } }
    : command instanceof GetObjectCommand ? { Body: Readable.from([wrong]) } : undefined) as typeof client.send;
  await assert.rejects(() => createUploadR2(config, client).verify({ key: objectKey, contentType: "text/csv",
    sha256: digest, sizeBytes: bytes.length }), { message: "knowledge_upload_integrity_mismatch" });
});
