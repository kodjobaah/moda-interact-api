import { parseCredentialKeyring, resolveActiveCredentialKey, type CredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { createApiPlatformConfigurationService, type ApiPlatformConfigurationReader } from "./service.js";
import { ApiPlatformConfigurationError, type ApiConfigurationKey } from "./errors.js";

/** Per-operation root keyring resolution. Root material is deployment-owned, never DB-owned. */
export function createApiPlatformConfigurationReader(input: {
  prisma: Pick<PrismaClient, "platformConfiguration">;
  environment: string;
  unsealEnvironment?: Readonly<NodeJS.ProcessEnv>;
  /** Inject the existing API shared logger; no additional logger or credential serialization. */
  logger?: Pick<StructuredLogger, "info" | "warn" | "error">;
}): ApiPlatformConfigurationReader {
  const unsealEnvironment = input.unsealEnvironment ?? process.env;
  const service = () => {
    let unsealKeyring: CredentialKeyring | undefined;
    try {
      unsealKeyring = parseCredentialKeyring(unsealEnvironment.MODA_CONFIG_UNSEAL_KEY);
      resolveActiveCredentialKey(unsealKeyring, unsealEnvironment.MODA_CONFIG_UNSEAL_ACTIVE_KEY_ID);
    } catch { /* The API-001 service fails closed when a sealed operation has no root. */ }
    return createApiPlatformConfigurationService({
      database: {
        platformConfiguration: {
          findUnique: (args) => input.prisma.platformConfiguration.findUnique({
            where: args.where, select: args.select,
          }),
        },
      },
      environment: input.environment, ...(unsealKeyring ? { unsealKeyring } : {}),
    });
  };
  /** Log only the fixed purpose and bounded outcome: no values, URLs, key IDs or exception text. */
  function logRead(level: "info" | "warn" | "error", fields: Record<string, string>): void {
    try {
      input.logger?.[level]("api.platform_configuration.read", fields);
    } catch { /* Logging is diagnostic and must not affect configuration reads. */ }
  }

  async function observedRead<T>(key: ApiConfigurationKey, operation: string, read: () => Promise<T>): Promise<T> {
    try {
      const result = await read();
      logRead("info", { key, operation, outcome: "success" });
      return result;
    } catch (error) {
      if (error instanceof ApiPlatformConfigurationError) {
        logRead("warn", { key, operation, outcome: "failed", reasonCode: error.code });
      } else {
        logRead("error", { key, operation, outcome: "failed", reasonCode: "UNEXPECTED" });
      }
      throw error;
    }
  }
  return Object.freeze({
    readMerchantKnowledgeUploadPolicy: () => observedRead(
      "merchant.knowledge.r2", "read_upload_policy", () => service().readMerchantKnowledgeUploadPolicy()),
    requireMerchantKnowledgeR2Configuration: () => observedRead(
      "merchant.knowledge.r2", "require_r2_configuration", () => service().requireMerchantKnowledgeR2Configuration()),
    requireCommerceConnectionSecurity: () => observedRead(
      "commerce.connectionKeys", "require_connection_security", () => service().requireCommerceConnectionSecurity()),
    requireMetaWebhookSecrets: () => observedRead(
      "messaging.meta", "require_webhook_secrets", () => service().requireMetaWebhookSecrets()),
  });
}
