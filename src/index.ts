import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { WooInstallationAuthenticator } from "./auth/woo-installation/authenticator.js";
import { createBillingRoutes } from "./composition/billing.js";
import { createMerchantRoutes } from "./composition/merchant.js";
import { composeApiRoutes } from "./composition/routes.js";
import { createWooRoutes } from "./composition/woocommerce.js";
import { createDatabase } from "./database.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { createApiRuntime, registerShutdownHandlers } from "./server.js";
import { createWooCheckoutRedisProducer } from "./woocommerce/activity/redis-producer.js";
import { createApiPlatformConfigurationReader } from "./platform-configuration/composition.js";
import { MerchantSupportTranslationDispatcher } from "./merchant/support/translation-queue.js";

const logger = createLogger({
  serviceName: "moda-interact-api",
  environment: process.env.NODE_ENV?.trim() || "development",
});

async function main(): Promise<void> {
  try {
    const config = loadRuntimeConfig(process.env);
    const database = createDatabase(config.databaseUrl);
    const authenticator = new WooInstallationAuthenticator(database.prisma);
    const platformConfiguration = createApiPlatformConfigurationReader({
      prisma: database.prisma, environment: config.environment, logger,
    });
    const supportTranslations = new MerchantSupportTranslationDispatcher(process.env.REDIS_URL);
    const merchant = createMerchantRoutes({
      prisma: database.prisma, authenticator, logger, environment: config.environment, platformConfiguration,
      supportTranslationDispatch: supportTranslations,
    });
    const billing = createBillingRoutes({
      prisma: database.prisma, authenticator, logger, wooBilling: config.wooBilling, platformConfiguration,
    });
    const activityQueues = createWooCheckoutRedisProducer(process.env.REDIS_URL);
    const woo = createWooRoutes({ prisma: database.prisma, config, authenticator, logger, platformConfiguration,
      checkoutPublisher: activityQueues.publisher, orderPublisher: activityQueues.orderPublisher });
    const handlers = composeApiRoutes({
      ...(woo.restRead ? { wooRestRead: woo.restRead } : {}),
      wooBillingWebhook: woo.billingWebhook,
      wooActivity: woo.activity,
      wooConsent: woo.consent,
      wooConsentStatus: woo.consentStatus,
      wooShopBrand: woo.shopBrand,
      wooRecoverySelection: woo.recoverySelection,
      wooRecoveryRestore: woo.recoveryRestore,
      merchant,
      billing,
      wooInstallation: woo.installation,
    });
    const runtime = createApiRuntime(config, database, logger, handlers, async () => {
      await Promise.all([activityQueues.close(),supportTranslations.close()]);
    });
    registerShutdownHandlers(runtime);
    await runtime.start();
  } catch (error) {
    logger.error("api.startup.failed", { error,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      errorCause: error instanceof Error ? error.cause : undefined,
    });
    process.exitCode = 1;
  }
}

void main();
