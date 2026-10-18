import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { encryptCredential, parseCredentialKeyring } from
  "@modainteract/moda-interact-shared/security/credentials/node";
import { apiPlatformConfigurationAad } from "../../../src/platform-configuration/contracts.js";
import { ApiPlatformConfigurationError } from "../../../src/platform-configuration/errors.js";
import { createApiPlatformConfigurationService } from "../../../src/platform-configuration/service.js";
import { adminR2PlaintextFixture } from "../../fixtures/platform-configuration/r2-admin-payload.js";

const url = process.env.ARCH043_API_TEST_DATABASE_URL;
function requireDatabaseUrl(): string {
  if (!url) throw new Error("ARCH043_API_TEST_DATABASE_URL is required for PostgreSQL integration tests");
  return url;
}
const root = parseCredentialKeyring(JSON.stringify({ wrapping: randomBytes(32).toString("base64") }));
const cryptoPrevious = randomBytes(32).toString("base64");
const cryptoCurrent = randomBytes(32).toString("base64");
const hmac = randomBytes(32).toString("base64");
const policy = { ...adminR2PlaintextFixture, maxUploadBytes: 1000,
  maxXlsxUncompressedBytes: 5000, bucket: "first-bucket" };
const commerce = { connectionKeysJson: JSON.stringify({ old: cryptoPrevious, current: cryptoCurrent }),
  activeKeyId: "current", commandHmacKey: hmac };
const meta = { META_APP_SECRET: "0123456789abcdef0123456789abcdef", WHATSAPP_VERIFY_TOKEN: "secret-verify-token" };

function sealed(environment: string, key: "merchant.knowledge.r2" | "commerce.connectionKeys" | "messaging.meta", version: number, payload: unknown) {
  const envelope = encryptCredential({ keyring: root, activeKeyId: "wrapping", plaintext: JSON.stringify(payload),
    aad: apiPlatformConfigurationAad(environment, key, version) });
  return { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: envelope.keyId,
    nonce: Buffer.from(envelope.nonce).toString("base64"), ciphertext: Buffer.from(envelope.ciphertext).toString("base64"),
    authTag: Buffer.from(envelope.authTag).toString("base64") };
}
function failed(promise: Promise<unknown>, code: ApiPlatformConfigurationError["code"]) {
  return assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof ApiPlatformConfigurationError) || error.code !== code) return false;
    const diagnostic = `${error.message} ${JSON.stringify(error)}`;
    return [hmac, policy.accessKeyId, policy.secretAccessKey, commerce.connectionKeysJson,
      meta.META_APP_SECRET, meta.WHATSAPP_VERIFY_TOKEN].every((secret) => !diagnostic.includes(secret));
  });
}

// The launcher always supplies a fresh disposable PostgreSQL DATABASE_URL.
test("PostgreSQL: missing policy, current committed policy and cross-environment isolation", { skip: !url }, async () => {
  const db = new PrismaClient({ datasources: { db: { url: requireDatabaseUrl() } } });
  const service = createApiPlatformConfigurationService({ database: db, environment: "test", unsealKeyring: root });
  try {
    await failed(service.readMerchantKnowledgeUploadPolicy(), "MISSING");
    await db.platformConfiguration.create({ data: { environment: "production", key: "merchant.knowledge.r2", value: sealed("production", "merchant.knowledge.r2", 1, policy) } });
    await failed(service.readMerchantKnowledgeUploadPolicy(), "MISSING");
    await db.platformConfiguration.create({ data: { environment: "test", key: "merchant.knowledge.r2", value: sealed("test", "merchant.knowledge.r2", 1, policy) } });
    assert.equal((await service.readMerchantKnowledgeUploadPolicy()).r2Bucket, "first-bucket");
    assert.equal((await service.requireMerchantKnowledgeR2Configuration()).r2AccessKeyId, policy.accessKeyId);
    const projection = await service.readMerchantKnowledgeUploadPolicy();
    assert.equal(Object.hasOwn(projection, "r2SecretAccessKey"), false);
    assert.equal(Object.hasOwn(projection, "r2AccessKeyId"), false);
    assert.equal(JSON.stringify(projection).includes(policy.secretAccessKey), false);
    await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key: "merchant.knowledge.r2" } },
      data: { value: sealed("test", "merchant.knowledge.r2", 2,
        { ...policy, bucket: "replacement-bucket", maxUploadBytes: 450 }), version: { increment: 1 } } });
    assert.equal((await service.readMerchantKnowledgeUploadPolicy()).r2Bucket, "replacement-bucket");
    assert.equal((await service.readMerchantKnowledgeUploadPolicy()).maxUploadBytes, 450);
    await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key: "merchant.knowledge.r2" } },
      data: { value: sealed("test", "merchant.knowledge.r2", 3,
        { ...policy, endpoint: "http://127.0.0.1" }), version: { increment: 1 } } });
    await failed(service.readMerchantKnowledgeUploadPolicy(), "INVALID_VALUE");
    // The exact six-field registry payload is sealed. A plaintext row is never valid.
    await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key: "merchant.knowledge.r2" } },
      data: { value: policy, version: 4 } });
    await failed(service.requireMerchantKnowledgeR2Configuration(), "INVALID_ENVELOPE");
    // D001 still allows this legacy-only row; the API must NEVER query it.
    await db.platformConfiguration.create({ data: { environment: "test", key: "merchantKnowledge.upload", value: {
      maxUploadBytes: 500, maxXlsxUncompressedBytes: 1000,
      r2Endpoint: policy.endpoint, r2Bucket: policy.bucket,
    } } });
    await db.platformConfiguration.delete({ where: { environment_key: { environment: "test", key: "merchant.knowledge.r2" } } });
    await failed(service.readMerchantKnowledgeUploadPolicy(), "MISSING");
    // Restore canonical row: disabled and malformed values must fail closed, with no fallback.
    await db.platformConfiguration.create({ data: { environment: "test", key: "merchant.knowledge.r2",
      value: { kind: "disabled", schemaVersion: 1 } } });
    await failed(service.readMerchantKnowledgeUploadPolicy(), "DISABLED");
    await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key: "merchant.knowledge.r2" } },
      data: { value: { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM" }, version: 2 } });
    await failed(service.requireMerchantKnowledgeR2Configuration(), "INVALID_ENVELOPE");
    await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key: "merchant.knowledge.r2" } },
      data: { value: sealed("test", "merchant.knowledge.r2", 3, policy), version: 3 } });
    const noRoot = createApiPlatformConfigurationService({ database: db, environment: "test" });
    await failed(noRoot.readMerchantKnowledgeUploadPolicy(), "UNSEAL_FAILED");
    const wrongRoot = createApiPlatformConfigurationService({ database: db, environment: "test",
      unsealKeyring: parseCredentialKeyring(JSON.stringify({ wrapping: randomBytes(32).toString("base64") })) });
    await failed(wrongRoot.requireMerchantKnowledgeR2Configuration(), "UNSEAL_FAILED");
    const success = await service.requireMerchantKnowledgeR2Configuration();
    assert.equal(success.r2SecretAccessKey, policy.secretAccessKey);
  } finally { await db.$disconnect(); }
});

test("PostgreSQL: Commerce keyring old IDs, rotation, AAD binding and ciphertext tampering", { skip: !url }, async () => {
  const db = new PrismaClient({ datasources: { db: { url: requireDatabaseUrl() } } });
  const key = "commerce.connectionKeys";
  const service = createApiPlatformConfigurationService({ database: db, environment: "test", unsealKeyring: root });
  try {
    await db.platformConfiguration.create({ data: { environment: "test", key, version: 1, value: sealed("test", key, 1, commerce) } });
    assert.ok((await service.requireCommerceConnectionSecurity()).keyring.hasKey("old"));
    await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key } },
      data: { value: sealed("test", key, 2, { ...commerce, activeKeyId: "old" }), version: 2 } });
    assert.equal((await service.requireCommerceConnectionSecurity()).activeKeyId, "old");
    await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key } },
      data: { value: sealed("test", key, 1, commerce), version: 3 } });
    await failed(service.requireCommerceConnectionSecurity(), "UNSEAL_FAILED");
    const damaged = sealed("test", key, 4, commerce);
    await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key } },
      data: { value: { ...damaged, ciphertext: "AAAA" }, version: 4 } });
    await failed(service.requireCommerceConnectionSecurity(), "UNSEAL_FAILED");
    const wrong = createApiPlatformConfigurationService({ database: db, environment: "test",
      unsealKeyring: parseCredentialKeyring(JSON.stringify({ wrapping: randomBytes(32).toString("base64") })) });
    await failed(wrong.requireCommerceConnectionSecurity(), "UNSEAL_FAILED");
  } finally { await db.$disconnect(); }
});

test("PostgreSQL: Meta secret validates own purpose and disabled tombstone", { skip: !url }, async () => {
  const db = new PrismaClient({ datasources: { db: { url: requireDatabaseUrl() } } });
  const key = "messaging.meta";
  const service = createApiPlatformConfigurationService({ database: db, environment: "test", unsealKeyring: root });
  try {
    await db.platformConfiguration.create({ data: { environment: "test", key, value: sealed("test", key, 1, meta) } });
    assert.equal((await service.requireMetaWebhookSecrets()).whatsappVerifyToken, meta.WHATSAPP_VERIFY_TOKEN);
    await db.platformConfiguration.update({ where: { environment_key: { environment: "test", key } },
      data: { value: { kind: "disabled", schemaVersion: 1 }, version: 2 } });
    await failed(service.requireMetaWebhookSecrets(), "DISABLED");
  } finally { await db.$disconnect(); }
});

test("PostgreSQL: uniqueness on environment and key is enforced", { skip: !url }, async () => {
  const db = new PrismaClient({ datasources: { db: { url: requireDatabaseUrl() } } });
  try {
    await assert.rejects(db.platformConfiguration.create({
      data: { environment: "test", key: "merchant.knowledge.r2", value: sealed("test", "merchant.knowledge.r2", 1, policy) },
    }));
  } finally { await db.$disconnect(); }
});
