import { createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { integrity, unavailable } from "./upload-contract.js";
import { timeKnowledgePhase, type KnowledgeTimings } from "./timing.js";

export interface UploadR2Configuration {
  bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string;
  maxUploadBytes: number;
}
export interface UploadR2 {
  sign(input: { key: string; contentType: string; sha256: string; expiresIn: number }): Promise<string>;
  verify(input: { key: string; contentType: string; sha256: string; sizeBytes: number },
    timings?: KnowledgeTimings): Promise<void>;
}
/** Legacy test fixture parser. Production composition never invokes this environment reader. */
export function loadUploadR2Configuration(env: NodeJS.ProcessEnv = process.env): UploadR2Configuration {
  const bucket = env.MERCHANT_KNOWLEDGE_R2_BUCKET;
  const accessKeyId = env.MERCHANT_KNOWLEDGE_R2_ACCESS_KEY_ID;
  const secretAccessKey = env.MERCHANT_KNOWLEDGE_R2_SECRET_ACCESS_KEY;
  const maximum = env.MERCHANT_KNOWLEDGE_MAX_UPLOAD_BYTES;
  let endpoint: URL;
  try { endpoint = new URL(env.MERCHANT_KNOWLEDGE_R2_ENDPOINT ?? ""); }
  catch { throw unavailable(); }
  if (endpoint.protocol !== "https:" || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== "/" || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(endpoint.hostname) ||
      !bucket || !/^[A-Za-z0-9._-]{3,63}$/.test(bucket) || !accessKeyId?.trim() || !secretAccessKey?.trim() ||
      !maximum || !/^[1-9]\d*$/.test(maximum)) throw unavailable();
  const maxUploadBytes = Number(maximum);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1 || maxUploadBytes > 25 * 1024 * 1024) throw unavailable();
  return { endpoint: endpoint.toString(), bucket, accessKeyId, secretAccessKey, maxUploadBytes };
}
export function createUploadR2(config: UploadR2Configuration, injectedClient?: S3Client): UploadR2 {
  const client = injectedClient ?? new S3Client({ endpoint: config.endpoint, region: "auto", forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // The Blob bytes are sent later by a different client. Do not automatically
    // sign an SDK-computed CRC32 of the empty presigning request into its URL.
    // Finalise independently rehashes the actual uploaded object with SHA-256.
    requestChecksumCalculation: "WHEN_REQUIRED",
    maxAttempts: 2 });
  return {
    async sign({ key, contentType, sha256, expiresIn }) {
      try {
        const signed = await getSignedUrl(client, new PutObjectCommand({ Bucket: config.bucket, Key: key,
          ContentType: contentType, IfNoneMatch: "*", Metadata: { sha256 } }), { expiresIn,
          // Preserve browser-sendable signed headers for the direct R2 Blob PUT.
          // Do not hoist requiredHeaders metadata into the signed URL query.
          unhoistableHeaders: new Set(["x-amz-meta-sha256"]),
          signableHeaders: new Set(["content-type", "if-none-match"]),
        });
        const url = new URL(signed);
        if (url.protocol !== "https:" || url.origin !== new URL(config.endpoint).origin || url.username || url.password ||
          url.hash || !url.searchParams.has("X-Amz-Signature")) throw unavailable();
        return signed;
      } catch { throw unavailable(); }
    },
    async verify({ key, contentType, sha256, sizeBytes }, timings) {
      if (sizeBytes < 1 || sizeBytes > config.maxUploadBytes) throw integrity();
      try {
        const head = await timeKnowledgePhase(timings, "r2HeadMs", () =>
          client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key })));
        if (head.ContentLength !== sizeBytes || head.ContentType?.toLowerCase() !== contentType ||
          head.Metadata?.sha256 !== sha256) throw integrity();
        const object = await timeKnowledgePhase(timings, "r2GetMs", () =>
          client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })));
        const body = object.Body;
        if (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function")
          throw unavailable();
        // AWS SDK bodies can also be browser streams at the type level. This Node
        // transport requires a real async iterable to verify bytes incrementally.
        const stream = body as AsyncIterable<Uint8Array> & { destroy?: () => void };
        await timeKnowledgePhase(timings, "r2HashMs", async () => {
          let bytes = 0;
          const hash = createHash("sha256");
          for await (const chunk of stream) {
            bytes += chunk.byteLength;
            if (bytes > config.maxUploadBytes || bytes > sizeBytes) {
              stream.destroy?.();
              throw integrity();
            }
            hash.update(chunk);
          }
          if (bytes !== sizeBytes || hash.digest("hex") !== sha256) throw integrity();
        });
      } catch (error) {
        if (error instanceof Error && error.message === "knowledge_upload_integrity_mismatch") throw error;
        throw unavailable();
      }
    },
  };
}
