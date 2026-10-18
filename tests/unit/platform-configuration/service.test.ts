import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  encryptCredential, parseCredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import { apiPlatformConfigurationAad } from "../../../src/platform-configuration/contracts.js";
import { ApiPlatformConfigurationError } from "../../../src/platform-configuration/errors.js";
import { createApiPlatformConfigurationService } from "../../../src/platform-configuration/service.js";
import type { ApiPlatformConfigurationDatabase, PlatformConfigurationRow } from "../../../src/platform-configuration/repository.js";
import { adminR2PlaintextFixture } from "../../fixtures/platform-configuration/r2-admin-payload.js";

const root = parseCredentialKeyring(JSON.stringify({ "root-v1": randomBytes(32).toString("base64") }));
const previous = randomBytes(32).toString("base64");
const current = randomBytes(32).toString("base64");
const hmac = randomBytes(32).toString("base64");
const keyValues = { connectionKeysJson: JSON.stringify({ previous, current }), activeKeyId: "current", commandHmacKey: hmac };
const validPolicy = adminR2PlaintextFixture;

function sealed(environment: string, key: "merchant.knowledge.r2" | "commerce.connectionKeys" | "messaging.meta", version: number, payload: unknown) {
  const envelope = encryptCredential({ keyring: root, activeKeyId: "root-v1", plaintext: JSON.stringify(payload),
    aad: apiPlatformConfigurationAad(environment, key, version) });
  return { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: envelope.keyId,
    nonce: Buffer.from(envelope.nonce).toString("base64"), ciphertext: Buffer.from(envelope.ciphertext).toString("base64"),
    authTag: Buffer.from(envelope.authTag).toString("base64") };
}

function fixture(environment = "test") {
  const rows = new Map<string, PlatformConfigurationRow>();
  const queries: string[] = [];
  const database: ApiPlatformConfigurationDatabase = { platformConfiguration: {
    async findUnique({ where }) {
      const { environment: env, key } = where.environment_key;
      queries.push(`${env}:${key}`);
      return rows.get(`${env}:${key}`) ?? null;
    },
  } };
  const service = createApiPlatformConfigurationService({ database, environment, unsealKeyring: root });
  function set(env: string, key: string, value: unknown, version = 1) {
    rows.set(`${env}:${key}`, { environment: env, key, version, value });
  }
  return { service, set, queries, database };
}

async function fails(promise: Promise<unknown>, code: ApiPlatformConfigurationError["code"]) {
  await assert.rejects(promise, (error: unknown) => error instanceof ApiPlatformConfigurationError &&
    error.code === code && !JSON.stringify(error).includes(previous) && !error.message.includes(hmac));
}

test("upload policy: editable location, size bounds, no cache, no cross-environment fallback", async () => {
  const { service, set, queries } = fixture();
  await fails(service.readMerchantKnowledgeUploadPolicy(), "MISSING");
  set("production", "merchant.knowledge.r2", sealed("production", "merchant.knowledge.r2", 1, validPolicy));
  await fails(service.readMerchantKnowledgeUploadPolicy(), "MISSING");
  set("test", "merchant.knowledge.r2", sealed("test", "merchant.knowledge.r2", 1, validPolicy));
  assert.equal((await service.readMerchantKnowledgeUploadPolicy()).r2Bucket, "knowledge-bucket");
  set("test", "merchant.knowledge.r2", sealed("test", "merchant.knowledge.r2", 2,
    { ...validPolicy, bucket: "next-bucket", maxUploadBytes: 500 }), 2);
  assert.equal((await service.readMerchantKnowledgeUploadPolicy()).maxUploadBytes, 500);
  assert.equal((await service.readMerchantKnowledgeUploadPolicy()).r2Bucket, "next-bucket");
  assert.ok(queries.every((q) => q === "test:merchant.knowledge.r2"));
  const full = await service.requireMerchantKnowledgeR2Configuration();
  assert.equal(full.r2AccessKeyId, validPolicy.accessKeyId);
  assert.equal(full.r2SecretAccessKey, validPolicy.secretAccessKey);
  assert.equal(Object.hasOwn(await service.readMerchantKnowledgeUploadPolicy(), "r2AccessKeyId"), false);
  assert.equal(Object.hasOwn(await service.readMerchantKnowledgeUploadPolicy(), "r2SecretAccessKey"), false);
  // Credentials must not be accepted as plaintext configuration.
  set("test", "merchant.knowledge.r2", validPolicy, 3);
  await fails(service.requireMerchantKnowledgeR2Configuration(), "INVALID_ENVELOPE");
  set("test", "merchant.knowledge.r2", sealed("test", "merchant.knowledge.r2", 3, validPolicy), 3);
  const tampered = sealed("test", "merchant.knowledge.r2", 3, validPolicy);
  set("test", "merchant.knowledge.r2", { ...tampered, ciphertext: "AAAA" }, 3);
  await fails(service.requireMerchantKnowledgeR2Configuration(), "UNSEAL_FAILED");
  for (const value of [{ ...validPolicy, endpoint: "http://localhost" },
    { ...validPolicy, endpoint: "https://127.0.0.1" },
    { ...validPolicy, extraField: true },
    { ...validPolicy, maxUploadBytes: 25 * 1024 * 1024 + 1 },
    { ...validPolicy, maxXlsxUncompressedBytes: 100 * 1024 * 1024 + 1 },
    { ...validPolicy, accessKeyId: "" },
    { ...validPolicy, secretAccessKey: "" },
    { ...validPolicy, r2Endpoint: validPolicy.endpoint },
    { ...validPolicy, r2Bucket: validPolicy.bucket },
    { ...validPolicy, r2AccessKeyId: validPolicy.accessKeyId },
    { ...validPolicy, r2SecretAccessKey: validPolicy.secretAccessKey }]) {
    set("test", "merchant.knowledge.r2", sealed("test", "merchant.knowledge.r2", 3, value), 3);
    await fails(service.readMerchantKnowledgeUploadPolicy(), "INVALID_VALUE");
  }
});

test("sealed Commerce keyring: previous keys, rotation, tampering and root isolation", async () => {
  const { service, set, database } = fixture();
  const key = "commerce.connectionKeys";
  set("test", key, sealed("test", key, 1, keyValues));
  const first = await service.requireCommerceConnectionSecurity();
  assert.ok(first.keyring.hasKey("previous"));
  assert.ok(first.keyring.hasKey("current"));
  assert.equal(first.activeKeyId, "current");
  assert.equal(first.commandHmacKey, hmac);
  set("test", key, sealed("test", key, 2, { ...keyValues, activeKeyId: "previous" }), 2);
  assert.equal((await service.requireCommerceConnectionSecurity()).activeKeyId, "previous");
  set("test", key, sealed("test", key, 3, { connectionKeysJson: keyValues.connectionKeysJson,
    activeKeyId: "current" }), 3);
  const withoutHmac = await service.requireCommerceConnectionSecurity();
  assert.equal(withoutHmac.activeKeyId, "current");
  assert.equal(withoutHmac.commandHmacKey, undefined);
  set("test", key, sealed("test", key, 1, keyValues), 2);
  await fails(service.requireCommerceConnectionSecurity(), "UNSEAL_FAILED");
  const envelope = sealed("test", key, 2, keyValues);
  set("test", key, { ...envelope, ciphertext: "AAAA" }, 2);
  await fails(service.requireCommerceConnectionSecurity(), "UNSEAL_FAILED");
  set("test", key, { kind: "disabled", schemaVersion: 1 }, 3);
  await fails(service.requireCommerceConnectionSecurity(), "DISABLED");
  set("test", key, { ...envelope, algorithm: "DES" }, 4);
  await fails(service.requireCommerceConnectionSecurity(), "INVALID_ENVELOPE");
  const noRoot = createApiPlatformConfigurationService({ database, environment: "test" });
  set("test", key, envelope, 2);
  await fails(noRoot.requireCommerceConnectionSecurity(), "UNSEAL_FAILED");
  const wrongRoot = createApiPlatformConfigurationService({ database, environment: "test",
    unsealKeyring: parseCredentialKeyring(JSON.stringify({ "root-v1": randomBytes(32).toString("base64") })) });
  await fails(wrongRoot.requireCommerceConnectionSecurity(), "UNSEAL_FAILED");
});

test("Meta secret purpose: strict fields, AAD purpose binding and no generic secret API", async () => {
  const { service, set } = fixture();
  const key = "messaging.meta";
  const payload = { META_APP_SECRET: "abcdef1234567890abcdef1234567890", WHATSAPP_VERIFY_TOKEN: "verify-token" };
  set("test", key, sealed("test", key, 1, payload));
  assert.deepEqual(await service.requireMetaWebhookSecrets(), {
    metaAppSecret: payload.META_APP_SECRET, whatsappVerifyToken: payload.WHATSAPP_VERIFY_TOKEN,
  });
  set("test", key, sealed("test", "commerce.connectionKeys", 2, payload), 2);
  await fails(service.requireMetaWebhookSecrets(), "UNSEAL_FAILED");
  set("test", key, sealed("test", key, 3, { ...payload, extra: "unexpected" }), 3);
  await fails(service.requireMetaWebhookSecrets(), "INVALID_VALUE");
  set("test", key, { kind: "disabled", schemaVersion: 1 }, 4);
  await fails(service.requireMetaWebhookSecrets(), "DISABLED");
  assert.deepEqual(Object.keys(service).sort(), [
    "readMerchantKnowledgeUploadPolicy", "requireMerchantKnowledgeR2Configuration",
    "requireCommerceConnectionSecurity", "requireMetaWebhookSecrets",
  ].sort());
});

test("database errors, invalid deployment environment and malformed row fail closed", async () => {
  const { service, set, database } = fixture();
  set("test", "merchant.knowledge.r2", sealed("test", "merchant.knowledge.r2", 1, validPolicy), 0);
  await fails(service.readMerchantKnowledgeUploadPolicy(), "INVALID_ROW");
  const incorrectEnvironment = createApiPlatformConfigurationService({ database, environment: "unknown", unsealKeyring: root });
  await fails(incorrectEnvironment.readMerchantKnowledgeUploadPolicy(), "INVALID_ENVIRONMENT");
  const down = createApiPlatformConfigurationService({ environment: "test", unsealKeyring: root,
    database: { platformConfiguration: { async findUnique() { throw new Error("secret-bearing connection detail"); } } } });
  await fails(down.requireMetaWebhookSecrets(), "DATABASE_UNAVAILABLE");
});


test("R2: ADMIN-002 sealed six-field interoperability, no legacy alias or fallback", async () => {
  const { service, set, queries } = fixture();
  assert.deepEqual(Object.keys(validPolicy).sort(), [
    "endpoint", "bucket", "accessKeyId", "secretAccessKey", "maxUploadBytes", "maxXlsxUncompressedBytes",
  ].sort());
  set("test", "merchantKnowledge.upload", validPolicy);
  // A populated old key must not make a missing canonical record appear configured.
  await fails(service.readMerchantKnowledgeUploadPolicy(), "MISSING");
  assert.deepEqual(queries, ["test:merchant.knowledge.r2"]);
  set("test", "merchant.knowledge.r2", sealed("test", "merchant.knowledge.r2", 1, validPolicy));
  assert.deepEqual(await service.readMerchantKnowledgeUploadPolicy(), {
    r2Endpoint: `${validPolicy.endpoint}/`, r2Bucket: validPolicy.bucket,
    maxUploadBytes: validPolicy.maxUploadBytes,
    maxXlsxUncompressedBytes: validPolicy.maxXlsxUncompressedBytes,
  });
  const credentials = await service.requireMerchantKnowledgeR2Configuration();
  assert.equal(credentials.r2AccessKeyId, validPolicy.accessKeyId);
  assert.equal(credentials.r2SecretAccessKey, validPolicy.secretAccessKey);
  assert.equal("r2AccessKeyId" in await service.readMerchantKnowledgeUploadPolicy(), false);
  assert.equal("r2SecretAccessKey" in await service.readMerchantKnowledgeUploadPolicy(), false);
  assert.ok(queries.every((entry) => entry === "test:merchant.knowledge.r2"));
});

test("R2: disabled/malformed envelopes, missing and wrong unseal root fail without secrets", async () => {
  const { service, set, database } = fixture();
  const key = "merchant.knowledge.r2";
  set("test", key, { kind: "disabled", schemaVersion: 1 });
  await fails(service.readMerchantKnowledgeUploadPolicy(), "DISABLED");
  await fails(service.requireMerchantKnowledgeR2Configuration(), "DISABLED");
  set("test", key, { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM" }, 2);
  await fails(service.readMerchantKnowledgeUploadPolicy(), "INVALID_ENVELOPE");
  set("test", key, sealed("test", key, 3, validPolicy), 3);
  const missingRoot = createApiPlatformConfigurationService({ database, environment: "test" });
  await fails(missingRoot.requireMerchantKnowledgeR2Configuration(), "UNSEAL_FAILED");
  const wrongRoot = createApiPlatformConfigurationService({ database, environment: "test",
    unsealKeyring: parseCredentialKeyring(JSON.stringify({ "root-v1": randomBytes(32).toString("base64") })) });
  await fails(wrongRoot.readMerchantKnowledgeUploadPolicy(), "UNSEAL_FAILED");
  // A row-version change must invalidate AAD and must not reveal the plaintext.
  set("test", key, sealed("test", key, 3, validPolicy), 4);
  await fails(service.requireMerchantKnowledgeR2Configuration(), "UNSEAL_FAILED");
  // The error must not contain any part of the R2 plaintext or envelope.
  try { await service.requireMerchantKnowledgeR2Configuration(); assert.fail("should reject"); }
  catch (error) {
    assert.ok(error instanceof ApiPlatformConfigurationError);
    const diagnostic = JSON.stringify(error);
    for (const secret of [validPolicy.accessKeyId, validPolicy.secretAccessKey, "fixture-only-secret-key"]) {
      assert.equal(diagnostic.includes(secret), false);
    }
  }
});
