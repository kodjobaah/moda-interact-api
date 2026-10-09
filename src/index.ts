import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createDatabase } from "./database.js";
import { BillingPresentationReadService } from "./billing/presentation/billing-read.service.js";
import { BillingPlanCatalogueReadService } from "./billing/presentation/plan-catalogue-read.service.js";
import { RecurringSubscriptionCommandService } from "./billing/commands/recurring-subscription-command.service.js";
import { RecoveryCreditPurchaseCommandService } from "./billing/commands/recovery-credit-purchase-command.service.js";
import { MerchantBootstrapReadService } from "./merchant/bootstrap/bootstrap-read.service.js";
import { MerchantRecoverySummaryService } from "./merchant/recovery-summary/recovery-summary.service.js";
import { createMerchantRecoverySummaryRoute } from "./merchant/recovery-summary/routes.js";
import { MerchantStoreContextService } from "./merchant/store-context/store-context.service.js";
import { StoreCategoriesReadService, commerceEnvironmentForApi } from "./merchant/store-categories/store-categories-read.service.js";
import { createStoreCategoriesRoute } from "./merchant/store-categories/routes.js";
import { StoreCategorySelectionService } from "./merchant/store-categories/store-category-selection.service.js";
import { createStoreCategorySelectionRoute } from "./merchant/store-categories/selection-routes.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { createApiRuntime, registerShutdownHandlers } from "./server.js";
import { WooInstallationAuthenticator } from "./woocommerce/installation/authenticator.js";
import { WooInstallationConnectionService } from "./woocommerce/installation/connection-service.js";
import { createWooInstallationRoutes } from "./woocommerce/installation/routes.js";
import { WooSiteVerifier } from "./woocommerce/installation/site-verifier.js";
import { WooBillingClient } from "./woocommerce/billing/woo-billing-client.js";
import { WooBillingWebhookReceiptService } from "./woocommerce/billing/webhooks/webhook-receipt.service.js";
import { createWooBillingWebhookRoute } from "./woocommerce/billing/webhooks/woo-billing-webhook-route.js";

const logger = createLogger({
  serviceName: "moda-interact-api",
  environment: process.env.NODE_ENV?.trim() || "development",
});

async function main(): Promise<void> {
  try {
    const config = loadRuntimeConfig(process.env);
    const database = createDatabase(config.databaseUrl);
    const verifier = new WooSiteVerifier({ mode: config.woocommerceConnectionMode });
    const connectionService = new WooInstallationConnectionService(database.prisma, verifier);
    const authenticator = new WooInstallationAuthenticator(database.prisma);
    const bootstrapReadService = new MerchantBootstrapReadService(database.prisma);
    const storeContextService = new MerchantStoreContextService(database.prisma);
    const storeCategoriesService = new StoreCategoriesReadService(database.prisma, commerceEnvironmentForApi(config.environment));
    const storeCategoriesRoute = createStoreCategoriesRoute({ service: storeCategoriesService, authenticator, logger });
    const storeCategorySelectionService = new StoreCategorySelectionService(
      database.prisma, commerceEnvironmentForApi(config.environment),
    );
    const storeCategorySelectionRoute = createStoreCategorySelectionRoute({
      service: storeCategorySelectionService, authenticator, logger,
    });
    const recoverySummaryRoute = createMerchantRecoverySummaryRoute({
      service: new MerchantRecoverySummaryService(database.prisma), authenticator, logger,
    });
    const billingReadService = new BillingPresentationReadService(database.prisma);
    const billingPlanCatalogueReadService = new BillingPlanCatalogueReadService(database.prisma, logger);
    const wooBillingClient = config.wooBilling ? new WooBillingClient(config.wooBilling) : undefined;
    const recurringSubscriptionCommandService = wooBillingClient && config.wooBilling
      ? new RecurringSubscriptionCommandService(database.prisma, wooBillingClient, config.wooBilling.environment)
      : undefined;
    const recoveryCreditPurchaseCommandService = wooBillingClient && config.wooBilling
      ? new RecoveryCreditPurchaseCommandService(database.prisma, wooBillingClient, config.wooBilling.environment)
      : undefined;
    const wooRoutes = createWooInstallationRoutes({
      mode: config.woocommerceConnectionMode,
      connectionService,
      bootstrapReadService,
      storeContextService,
      storeCategoriesRoute,
      storeCategorySelectionRoute,
      recoverySummaryRoute,
      billingReadService,
      billingPlanCatalogueReadService,
      ...(recurringSubscriptionCommandService ? { recurringSubscriptionCommandService } : {}),
      ...(recoveryCreditPurchaseCommandService ? { recoveryCreditPurchaseCommandService } : {}),
      authenticator,
      logger,
    });
    const wooBillingWebhookRoutes = createWooBillingWebhookRoute({
      ...(config.wooBilling ? { apiSecret: config.wooBilling.apiSecret } : {}),
      receiptService: new WooBillingWebhookReceiptService(database.prisma.wooCommerceBillingWebhookReceipt),
      logger,
    });
    const runtime = createApiRuntime(config, database, logger, wooRoutes, wooBillingWebhookRoutes);
    registerShutdownHandlers(runtime);
    await runtime.start();
  } catch {
    logger.error("api.startup.failed", { reason: "configuration_or_initialization" });
    process.exitCode = 1;
  }
}

void main();