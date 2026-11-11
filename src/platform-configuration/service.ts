import {
  decryptCredential,
  parseCredentialKeyring,
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
import { assertApiDeploymentEnvironment, readApiPlatformConfiguration, type ApiPlatformConfigurationDatabase } from "./repository.js";

export type CommerceConnectionSecurity = Readonly<{
  keyring: CredentialKeyring;
  activeKeyId: string;
}>;

export type MetaWebhookSecrets = Readonly<{
  metaAppSecret: string;
  whatsappVerifyToken: string;
}>;

export type WooBillingCredentials = Readonly<{ apiKey: string; apiSecret: string }>;

export interface ApiPlatformConfigurationReader {
  /** Fetch the current, complete sealed provider pair; no cache or environment fallback. */
  requireWooBillingCredentials(): Promise<WooBillingCredentials>;
  readMerchantKnowledgeUploadPolicy(): Promise<MerchantKnowledgeUploadPolicy>;
  /** Purpose-scoped server-only access to both R2 credentials and policy. */
  requireMerchantKnowledgeR2Configuration(): Promise<MerchantKnowledgeR2Configuration>;
  requireCommerceConnectionSecurity(): Promise<CommerceConnectionSecurity>;
  requireMetaWebhookSecrets(): Promise<MetaWebhookSecrets>;
  /** Current trusted sender WABA only, never the provider token or phone ID. */
  readMessagingSenderWabaId(): Promise<string>;
}

export interface ApiPlatformConfigurationDependencies {
  /** Prisma-compatible read-only port. Callers provision it, not HTTP clients. */
  database: ApiPlatformConfigurationDatabase;
  /** Trusted deployment identity, never a header or tenant-controlled value. */
  environment: string;
  /** Unified deployment keyring used to decrypt stored platform secrets. */
  unsealKeyring?: CredentialKeyring;
  encryptionEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

export function createApiPlatformConfigurationService(
  deps: ApiPlatformConfigurationDependencies,
): ApiPlatformConfigurationReader {
  async function readSecret(key: ApiConfigurationKey): Promise<unknown> {
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
    } catch (error) {
      return configurationError(key, "UNSEAL_FAILED", error);
    }
    try { return JSON.parse(plaintext) as unknown; }
    catch (error) { return configurationError(key, "INVALID_VALUE", error); }
  }

  return Object.freeze({
    async requireWooBillingCredentials(): Promise<WooBillingCredentials> {
      const key: ApiConfigurationKey = "woocommerce.billing";
      const value = await readSecret(key);
      if (!isClosedObject(value, ["apiKey", "apiSecret"]) ||
          !requiredSecret(value.apiKey, 1, 4096) ||
          !requiredSecret(value.apiSecret, 1, 4096)) {
        configurationError(key, "INVALID_VALUE");
      }
      return Object.freeze({ apiKey: value.apiKey as string, apiSecret: value.apiSecret as string });
    },
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
      assertApiDeploymentEnvironment(deps.environment, key);
      try {
        const environment = deps.encryptionEnvironment ?? process.env;
        const keyring = parseCredentialKeyring(environment.MODA_ENCRYPTION_KEYS_JSON);
        const activeKeyId = resolveActiveCredentialKey(keyring, environment.MODA_ENCRYPTION_ACTIVE_KEY_ID);
        return Object.freeze({ keyring, activeKeyId });
      } catch (error) {
        return configurationError(key, "INVALID_VALUE", error);
      }
    },
    async readMessagingSenderWabaId(): Promise<string> {
      const key: ApiConfigurationKey = "messaging.sender";
      const value = await readSecret(key);
      if (!isClosedObject(value, ["accessToken", "phoneNumberId", "businessAccountId"]) ||
          !requiredSecret(value.accessToken, 1, 8192) ||
          !requiredSecret(value.phoneNumberId, 1, 191) ||
          typeof value.businessAccountId !== "string" ||
          !/^\d{4,32}$/.test(value.businessAccountId)) {
        configurationError(key, "INVALID_VALUE");
      }
      return value.businessAccountId as string;
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
