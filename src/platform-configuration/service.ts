import {
  decryptCredential,
  parseCredentialKeyring,
  parseCommerceConnectionCommandHmacKey,
  resolveActiveCredentialKey,
  type CredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import {
  apiPlatformConfigurationAad,
  decodeMerchantKnowledgeR2Configuration,
  decodePlatformSecretEnvelope,
  isClosedObject,
  isDisabledPlatformSecret,
  requiredSecret,
  type MerchantKnowledgeUploadPolicy,
  type MerchantKnowledgeR2Configuration,
} from "./contracts.js";
import { configurationError, type ApiConfigurationKey } from "./errors.js";
import { readApiPlatformConfiguration, type ApiPlatformConfigurationDatabase } from "./repository.js";

export type CommerceConnectionSecurity = Readonly<{
  keyring: CredentialKeyring;
  activeKeyId: string;
  /** Only trusted server callers may obtain this command-authentication secret. */
  commandHmacKey?: string;
}>;

export type MetaWebhookSecrets = Readonly<{
  metaAppSecret: string;
  whatsappVerifyToken: string;
}>;

export interface ApiPlatformConfigurationReader {
  readMerchantKnowledgeUploadPolicy(): Promise<MerchantKnowledgeUploadPolicy>;
  /** Purpose-scoped server-only access to both R2 credentials and policy. */
  requireMerchantKnowledgeR2Configuration(): Promise<MerchantKnowledgeR2Configuration>;
  requireCommerceConnectionSecurity(): Promise<CommerceConnectionSecurity>;
  requireMetaWebhookSecrets(): Promise<MetaWebhookSecrets>;
}

export interface ApiPlatformConfigurationDependencies {
  /** Prisma-compatible read-only port. Callers provision it, not HTTP clients. */
  database: ApiPlatformConfigurationDatabase;
  /** Trusted deployment identity, never a header or tenant-controlled value. */
  environment: string;
  /** Independent externally provisioned unseal material, never the Commerce keyring. */
  unsealKeyring?: CredentialKeyring;
}

export function createApiPlatformConfigurationService(
  deps: ApiPlatformConfigurationDependencies,
): ApiPlatformConfigurationReader {
  async function readSecret(key: "merchant.knowledge.r2" | "commerce.connectionKeys" | "messaging.meta"): Promise<unknown> {
    const row = await readApiPlatformConfiguration(deps.database, deps.environment, key);
    if (isDisabledPlatformSecret(row.value)) configurationError(key, "DISABLED");
    const envelope = decodePlatformSecretEnvelope(key, row.value);
    if (!deps.unsealKeyring) configurationError(key, "UNSEAL_FAILED");
    let plaintext: string;
    try {
      plaintext = decryptCredential({
        keyring: deps.unsealKeyring, envelope,
        aad: apiPlatformConfigurationAad(row.environment, key, row.version),
      });
    } catch {
      return configurationError(key, "UNSEAL_FAILED");
    }
    try { return JSON.parse(plaintext) as unknown; }
    catch { return configurationError(key, "INVALID_VALUE"); }
  }

  return Object.freeze({
    async readMerchantKnowledgeUploadPolicy(): Promise<MerchantKnowledgeUploadPolicy> {
      const value = await readSecret("merchant.knowledge.r2");
      const { maxUploadBytes, maxXlsxUncompressedBytes, r2Endpoint, r2Bucket } =
        decodeMerchantKnowledgeR2Configuration(value);
      // Never include R2 credentials in the policy-only projection.
      return Object.freeze({ maxUploadBytes, maxXlsxUncompressedBytes, r2Endpoint, r2Bucket });
    },
    async requireMerchantKnowledgeR2Configuration(): Promise<MerchantKnowledgeR2Configuration> {
      const value = await readSecret("merchant.knowledge.r2");
      return decodeMerchantKnowledgeR2Configuration(value);
    },
    async requireCommerceConnectionSecurity(): Promise<CommerceConnectionSecurity> {
      const key: ApiConfigurationKey = "commerce.connectionKeys";
      const value = await readSecret(key);
      const withHmac = isClosedObject(value, ["connectionKeysJson", "activeKeyId", "commandHmacKey"]);
      if ((!withHmac && !isClosedObject(value, ["connectionKeysJson", "activeKeyId"])) ||
          !requiredSecret(value.connectionKeysJson, 1, 4096) ||
          !requiredSecret(value.activeKeyId, 1, 64) ||
          (withHmac && !requiredSecret(value.commandHmacKey, 1, 128))) {
        configurationError(key, "INVALID_VALUE");
      }
      try {
        const keyring = parseCredentialKeyring(value.connectionKeysJson as string);
        const activeKeyId = resolveActiveCredentialKey(keyring, value.activeKeyId as string);
        // HMAC is a Commerce command capability. Validate when present, but do not
        // expose it from the API's Woo read-grant encryption-key reader.
        if (withHmac) parseCommerceConnectionCommandHmacKey(value.commandHmacKey as string, keyring).fill(0);
        return Object.freeze({ keyring, activeKeyId,
          ...(withHmac ? { commandHmacKey: value.commandHmacKey as string } : {}),
        });
      } catch {
        return configurationError(key, "INVALID_VALUE");
      }
    },
    async requireMetaWebhookSecrets(): Promise<MetaWebhookSecrets> {
      const key: ApiConfigurationKey = "messaging.meta";
      const value = await readSecret(key);
      if (!isClosedObject(value, ["META_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"]) ||
          !requiredSecret(value.META_APP_SECRET, 16, 512) ||
          !requiredSecret(value.WHATSAPP_VERIFY_TOKEN, 1, 1024)) configurationError(key, "INVALID_VALUE");
      return Object.freeze({
        metaAppSecret: value.META_APP_SECRET as string,
        whatsappVerifyToken: value.WHATSAPP_VERIFY_TOKEN as string,
      });
    },
  });
}
