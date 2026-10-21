import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { encryptCredential, parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import { apiPlatformConfigurationAad } from "../../../src/platform-configuration/contracts.js";
import { createApiPlatformConfigurationReader } from "../../../src/platform-configuration/composition.js";
import { adminR2PlaintextFixture } from "../../fixtures/platform-configuration/r2-admin-payload.js";

type LoggedEvent = { level: string; event: string; data: Record<string, unknown> };

function fixture() {
  const events: LoggedEvent[] = [];
  const logger = {
    info: (event: string, data: Record<string, unknown>) => { events.push({ level: "info", event, data }); },
    warn: (event: string, data: Record<string, unknown>) => { events.push({ level: "warn", event, data }); },
    error: (event: string, data: Record<string, unknown>) => { events.push({ level: "error", event, data }); },
  };
  const rootMaterial = randomBytes(32).toString("base64");
  const rootJson = JSON.stringify({ root: rootMaterial });
  const root = parseCredentialKeyring(rootJson);
  const rows = new Map<string, unknown>();
  let failDatabase = false;
  let calls = 0;
  const reader = createApiPlatformConfigurationReader({
    environment: "test", unsealEnvironment: {
      MODA_CONFIG_UNSEAL_KEY: rootJson, MODA_CONFIG_UNSEAL_ACTIVE_KEY_ID: "root",
    },
    prisma: { platformConfiguration: { findUnique: async ({ where }: {
      where: { environment_key: { environment: string; key: string } };
    }) => {
      calls++;
      if (failDatabase) throw new Error("sensitive database error");
      return rows.get(`${where.environment_key.environment}:${where.environment_key.key}`) ?? null;
    } } } as never,
    logger: logger as never,
  });
  function seal(key: "merchant.knowledge.r2" | "commerce.connectionKeys" | "messaging.meta" | "woocommerce.billing", payload: unknown) {
    const envelope = encryptCredential({ keyring: root, activeKeyId: "root", plaintext: JSON.stringify(payload),
      aad: apiPlatformConfigurationAad("test", key, 1) });
    rows.set(`test:${key}`, { environment: "test", key, version: 1, value: {
      kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: envelope.keyId,
      nonce: Buffer.from(envelope.nonce).toString("base64"),
      ciphertext: Buffer.from(envelope.ciphertext).toString("base64"),
      authTag: Buffer.from(envelope.authTag).toString("base64"),
    } });
  }
  return { reader, events, logger, seal, rootMaterial, get calls() { return calls; },
    setDatabaseFailure(value: boolean) { failDatabase = value; },
    setRow(key: string, value: unknown) { rows.set(`test:${key}`, value); },
  };
}

test("the shared logger receives no startup event and a bounded failure for an absent row", async () => {
  const state = fixture();
  assert.equal(state.calls, 0);
  assert.deepEqual(state.events, []);
  await assert.rejects(state.reader.readMerchantKnowledgeUploadPolicy(), { code: "MISSING" });
  assert.equal(state.calls, 1);
  assert.deepEqual(state.events, [{
    level: "warn", event: "api.platform_configuration.read", data: {
      key: "merchant.knowledge.r2", operation: "read_upload_policy",
      outcome: "failed", reasonCode: "MISSING",
    },
  }]);
});

test("a successful policy-only or full R2 read logs no credential, payload, endpoint or root material", async () => {
  const state = fixture();
  state.seal("merchant.knowledge.r2", adminR2PlaintextFixture);
  const policy = await state.reader.readMerchantKnowledgeUploadPolicy();
  assert.equal(policy.r2Bucket, adminR2PlaintextFixture.bucket);
  const full = await state.reader.requireMerchantKnowledgeR2Configuration();
  assert.equal(full.r2SecretAccessKey, adminR2PlaintextFixture.secretAccessKey);
  assert.deepEqual(state.events.map((entry) => entry.data.operation), [
    "read_upload_policy", "require_r2_configuration",
  ]);
  assert.ok(state.events.every((entry) => entry.level === "info" && entry.data.outcome === "success"));
  const logs = JSON.stringify(state.events);
  for (const confidential of [adminR2PlaintextFixture.secretAccessKey, adminR2PlaintextFixture.accessKeyId,
    adminR2PlaintextFixture.endpoint, state.rootMaterial, "knowledge-bucket"]) {
    assert.equal(logs.includes(confidential), false);
  }
});

test("database failures are logged by bounded reason code, with no raw cause and no fallback", async () => {
  const state = fixture();
  state.setDatabaseFailure(true);
  await assert.rejects(state.reader.requireCommerceConnectionSecurity(), { code: "DATABASE_UNAVAILABLE" });
  assert.deepEqual(state.events, [{
    level: "warn", event: "api.platform_configuration.read", data: {
      key: "commerce.connectionKeys", operation: "require_connection_security",
      outcome: "failed", reasonCode: "DATABASE_UNAVAILABLE",
    },
  }]);
  assert.equal(JSON.stringify(state.events).includes("sensitive database error"), false);
});

test("logger sink failures do not change read success or configuration failure", async () => {
  const state = fixture();
  state.seal("merchant.knowledge.r2", adminR2PlaintextFixture);
  state.logger.info = () => { throw new Error("sink unavailable"); };
  const policy = await state.reader.readMerchantKnowledgeUploadPolicy();
  assert.equal(policy.r2Bucket, adminR2PlaintextFixture.bucket);

  state.setDatabaseFailure(true);
  state.logger.warn = () => { throw new Error("sink unavailable"); };
  await assert.rejects(state.reader.requireCommerceConnectionSecurity(), { code: "DATABASE_UNAVAILABLE" });
});

test("invalid envelopes and revoked webhook credentials fail closed and emit only safe reasons", async () => {
  const state = fixture();
  state.setRow("merchant.knowledge.r2", { environment: "test", key: "merchant.knowledge.r2", version: 1,
    value: { kind: "sealed", ciphertext: "sensitive bad payload" } });
  await assert.rejects(state.reader.requireMerchantKnowledgeR2Configuration(), { code: "INVALID_ENVELOPE" });
  state.setRow("messaging.meta", { environment: "test", key: "messaging.meta", version: 2,
    value: { kind: "disabled", schemaVersion: 1 } });
  await assert.rejects(state.reader.requireMetaWebhookSecrets(), { code: "DISABLED" });
  assert.deepEqual(state.events.map((entry) => entry.data.reasonCode), ["INVALID_ENVELOPE", "DISABLED"]);
  assert.equal(JSON.stringify(state.events).includes("sensitive bad payload"), false);
});


test("Woo billing reader logs only purpose and bounded outcome, not the sealed pair", async () => {
  const state = fixture();
  const key = "woocommerce.billing";
  const credentials = { apiKey: "billing-provider-api-key", apiSecret: "billing-provider-secret" };
  state.seal(key, credentials);
  assert.deepEqual(await state.reader.requireWooBillingCredentials(), credentials);
  assert.deepEqual(state.events, [{
    level: "info", event: "api.platform_configuration.read", data: {
      key, operation: "require_billing_credentials", outcome: "success",
    },
  }]);
  const text = JSON.stringify(state.events);
  assert.equal(text.includes(credentials.apiKey), false);
  assert.equal(text.includes(credentials.apiSecret), false);
  assert.equal(text.includes(state.rootMaterial), false);
  state.setDatabaseFailure(true);
  await assert.rejects(state.reader.requireWooBillingCredentials(), { code: "DATABASE_UNAVAILABLE" });
  assert.deepEqual(state.events[1]?.data, {
    key, operation: "require_billing_credentials", outcome: "failed", reasonCode: "DATABASE_UNAVAILABLE",
  });
});
