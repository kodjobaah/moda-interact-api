import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { S3Client, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { KnowledgeUploadError } from "../../../../src/merchant/merchant-knowledge/upload-contract.js";
import { createUploadR2 } from "../../../../src/merchant/merchant-knowledge/upload-r2.js";

const endpoint = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const config = { endpoint, bucket: "merchant-knowledge-test", accessKeyId: "test-key", secretAccessKey: "test-secret",
  maxUploadBytes: 1024 };
const body = Buffer.from("sku,name\n123,Sample\n");
const hash = createHash("sha256").update(body).digest("hex");

test("R2 signer returns bounded HTTPS account-specific signed URL and immutable required headers", async () => {
  const signed = await createUploadR2(config).sign({ key: "merchant-knowledge/test/woocommerce/shop/id/source.csv",
    contentType: "text/csv", sha256: hash, expiresIn: 600 });
  const uri = new URL(signed);
  assert.equal(uri.origin, endpoint);
  assert.ok(uri.searchParams.has("X-Amz-Signature"));
  assert.ok(uri.pathname.includes("merchant-knowledge/test/woocommerce/shop/id/source.csv"));
});

test("R2 finalisation performs HEAD metadata and bounded GET byte SHA-256, not only client-declared hash", async () => {
  const client = new S3Client({ endpoint, region: "auto", forcePathStyle: true,
    credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" } });
  let calls: string[] = [];
  // Injection controls the object transport; nothing is uploaded to a real R2 bucket.
  client.send = (async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      calls.push("HEAD");
      return { ContentLength: body.length, ContentType: "text/csv", Metadata: { sha256: hash } };
    }
    if (command instanceof GetObjectCommand) {
      calls.push("GET");
      return { Body: Readable.from([body]) };
    }
    throw new Error("unexpected command");
  }) as typeof client.send;
  const r2 = createUploadR2(config, client);
  const timings: Record<string, number> = {};
  await r2.verify({ key: "object", contentType: "text/csv", sha256: hash, sizeBytes: body.length }, timings);
  assert.deepEqual(calls, ["HEAD", "GET"]);
  assert.deepEqual(Object.keys(timings).sort(), ["r2HeadMs", "r2GetMs", "r2HashMs"].sort());
  assert.ok(Object.values(timings).every((milliseconds) => milliseconds >= 0 && Number.isFinite(milliseconds)));
  calls = [];
  const rejectedTimings: Record<string, number> = {};
  await assert.rejects(() => r2.verify({ key: "object", contentType: "text/csv", sha256: "b".repeat(64),
    sizeBytes: body.length }, rejectedTimings));
  assert.deepEqual(calls, ["HEAD"]);
  assert.deepEqual(Object.keys(rejectedTimings), ["r2HeadMs"]);
  client.send = (async (command: unknown) => command instanceof HeadObjectCommand
    ? { ContentLength: body.length, ContentType: "text/csv", Metadata: { sha256: hash } }
    : { Body: Readable.from([Buffer.alloc(body.length, 0x78)]) }) as typeof client.send;
  await assert.rejects(() => r2.verify({ key: "object", contentType: "text/csv", sha256: hash,
    sizeBytes: body.length }));
});

test("R2 transport failures return a bounded unavailable error without provider details", async () => {
  const client = new S3Client({ endpoint, region: "auto", forcePathStyle: true,
    credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" } });
  client.send = (async () => { throw new Error("private bucket credential diagnostic"); }) as typeof client.send;
  const r2 = createUploadR2(config, client);
  await assert.rejects(() => r2.verify({ key: "object", contentType: "text/csv", sha256: hash,
    sizeBytes: body.length }), (error: unknown) => error instanceof KnowledgeUploadError &&
      error.status === 503 && error.code === "knowledge_upload_unavailable" &&
      !error.message.includes("private bucket credential diagnostic"));
});
