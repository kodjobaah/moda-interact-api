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

const key = "woocommerce.billing";
const pair = { apiKey: "woo-billing-key", apiSecret: "woo-billing-secret" };
const root = parseCredentialKeyring(JSON.stringify({ active: randomBytes(32).toString("base64") }));

function seal(environment: string, version: number, payload: unknown, aadEnvironment = environment) {
  const envelope = encryptCredential({
    keyring: root, activeKeyId: "active", plaintext: JSON.stringify(payload),
    aad: apiPlatformConfigurationAad(aadEnvironment, key, version),
  });
  return {
    kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: envelope.keyId,
    nonce: Buffer.from(envelope.nonce).toString("base64"),
    ciphertext: Buffer.from(envelope.ciphertext).toString("base64"),
    authTag: Buffer.from(envelope.authTag).toString("base64"),
  };
}

function fixture(environment = "test") {
  const rows = new Map<string, PlatformConfigurationRow>();
  const requests: string[] = [];
  let offline = false;
  const database: ApiPlatformConfigurationDatabase = {
    platformConfiguration: {
      async findUnique({ where }) {
        const { environment: requestedEnvironment, key: purpose } = where.environment_key;
        requests.push(`${requestedEnvironment}:${purpose}`);
        if (offline) throw new Error("db-password=do-not-leak");
        return rows.get(`${requestedEnvironment}:${purpose}`) ?? null;
      },
    },
  };
  return {
    service: createApiPlatformConfigurationService({ database, environment, unsealKeyring: root }),
    requests,
    set(environmentName: string, version: number, value: unknown) {
      rows.set(`${environmentName}:${key}`, { environment: environmentName, key, version, value });
    },
    offline() { offline = true; },
    withoutRoot: createApiPlatformConfigurationService({ database, environment }),
    wrongEnvironment: createApiPlatformConfigurationService({ database, environment: "production", unsealKeyring: root }),
  };
}

async function expectFailure(operation: Promise<unknown>, code: ApiPlatformConfigurationError["code"]) {
  await assert.rejects(operation, (error: unknown) => error instanceof ApiPlatformConfigurationError &&
    error.code === code && !JSON.stringify(error).includes(pair.apiSecret) &&
    !JSON.stringify(error).includes("db-password"));
}

test("Woo billing pair is decrypted atomically once per operation and follows CAS rotation", async () => {
  const f = fixture();
  f.set("test", 1, seal("test", 1, pair));
  assert.deepEqual(await f.service.requireWooBillingCredentials(), pair);
  const rotated = { apiKey: "rotated-key", apiSecret: "rotated-secret" };
  f.set("test", 2, seal("test", 2, rotated));
  assert.deepEqual(await f.service.requireWooBillingCredentials(), rotated);
  assert.deepEqual(f.requests, [`test:${key}`, `test:${key}`]);
});

test("Woo billing credentials never fall back to another deployment environment or a different purpose", async () => {
  const f = fixture();
  f.set("production", 1, seal("production", 1, pair));
  await expectFailure(f.service.requireWooBillingCredentials(), "MISSING");
  assert.deepEqual(f.requests, [`test:${key}`]);
  f.set("test", 2, seal("test", 2, pair, "production"));
  await expectFailure(f.service.requireWooBillingCredentials(), "UNSEAL_FAILED");
  f.set("production", 2, seal("test", 2, pair));
  await expectFailure(f.wrongEnvironment.requireWooBillingCredentials(), "UNSEAL_FAILED");
});

test("Woo billing missing, disabled, partial, malformed and corrupt records fail closed", async () => {
  const f = fixture();
  await expectFailure(f.service.requireWooBillingCredentials(), "MISSING");
  f.set("test", 1, { kind: "disabled", schemaVersion: 1 });
  await expectFailure(f.service.requireWooBillingCredentials(), "DISABLED");
  f.set("test", 2, pair);
  await expectFailure(f.service.requireWooBillingCredentials(), "INVALID_ENVELOPE");
  for (const invalid of [{ apiKey: pair.apiKey }, { apiSecret: pair.apiSecret },
    { ...pair, extra: "unapproved" }, { ...pair, apiKey: " " }, { ...pair, apiSecret: "" },
    { ...pair, apiSecret: "x".repeat(4097) }]) {
    f.set("test", 3, seal("test", 3, invalid));
    await expectFailure(f.service.requireWooBillingCredentials(), "INVALID_VALUE");
  }
  f.set("test", 4, seal("test", 4, pair));
  await expectFailure(f.withoutRoot.requireWooBillingCredentials(), "UNSEAL_FAILED");
  f.set("test", 5, seal("test", 4, pair));
  await expectFailure(f.service.requireWooBillingCredentials(), "UNSEAL_FAILED");
  f.set("test", 6, { ...seal("test", 6, pair), ciphertext: "AAAA" });
  await expectFailure(f.service.requireWooBillingCredentials(), "UNSEAL_FAILED");
  f.offline();
  await expectFailure(f.service.requireWooBillingCredentials(), "DATABASE_UNAVAILABLE");
});

test("Woo billing errors do not accept unknown deployment identities or secret-bearing rows", async () => {
  const f = fixture("other");
  await expectFailure(f.service.requireWooBillingCredentials(), "INVALID_ENVIRONMENT");
});
