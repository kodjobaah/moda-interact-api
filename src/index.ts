import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createDatabase } from "./database.js";
import { BillingPresentationReadService } from "./billing/presentation/billing-read.service.js";
import { BillingPlanCatalogueReadService } from "./billing/presentation/plan-catalogue-read.service.js";
import { RecurringSubscriptionCommandService } from "./billing/commands/recurring-subscription-command.service.js";
import { MerchantBootstrapReadService } from "./merchant/bootstrap/bootstrap-read.service.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { createApiRuntime, registerShutdownHandlers } from "./server.js";
import { WooInstallationAuthenticator } from "./woocommerce/installation/authenticator.js";
import { WooInstallationConnectionService } from "./woocommerce/installation/connection-service.js";
import { createWooInstallationRoutes } from "./woocommerce/installation/routes.js";
import { WooSiteVerifier } from "./woocommerce/installation/site-verifier.js";
import { WooBillingClient } from "./woocommerce/billing/woo-billing-client.js";

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
    const billingReadService = new BillingPresentationReadService(database.prisma);
    const billingPlanCatalogueReadService = new BillingPlanCatalogueReadService(database.prisma, logger);
    const recurringSubscriptionCommandService = config.wooBilling
      ? new RecurringSubscriptionCommandService(
          database.prisma,
          new WooBillingClient(config.wooBilling),
          config.wooBilling.environment,
        )
      : undefined;
    const wooRoutes = createWooInstallationRoutes({
      mode: config.woocommerceConnectionMode,
      connectionService,
      bootstrapReadService,
      billingReadService,
      billingPlanCatalogueReadService,
      ...(recurringSubscriptionCommandService ? { recurringSubscriptionCommandService } : {}),
      authenticator,
      logger,
    });
    const runtime = createApiRuntime(config, database, logger, wooRoutes);
    registerShutdownHandlers(runtime);
    await runtime.start();
  } catch {
    logger.error("api.startup.failed", { reason: "configuration_or_initialization" });
    process.exitCode = 1;
  }
}

void main();