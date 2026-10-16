import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { WooInstallationAuthenticator } from "./auth/woo-installation/authenticator.js";
import { createBillingRoutes } from "./composition/billing.js";
import { createMerchantRoutes } from "./composition/merchant.js";
import { composeApiRoutes } from "./composition/routes.js";
import { createWooRoutes } from "./composition/woocommerce.js";
import { createDatabase } from "./database.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { createApiRuntime, registerShutdownHandlers } from "./server.js";

const logger = createLogger({
  serviceName: "moda-interact-api",
  environment: process.env.NODE_ENV?.trim() || "development",
});

async function main(): Promise<void> {
  try {
    const config = loadRuntimeConfig(process.env);
    const database = createDatabase(config.databaseUrl);
    const authenticator = new WooInstallationAuthenticator(database.prisma);
    const merchant = createMerchantRoutes({
      prisma: database.prisma, authenticator, logger, environment: config.environment,
    });
    const billing = createBillingRoutes({
      prisma: database.prisma, authenticator, logger, wooBilling: config.wooBilling,
    });
    const woo = createWooRoutes({ prisma: database.prisma, config, authenticator, logger });
    const handlers = composeApiRoutes({
      ...(woo.restRead ? { wooRestRead: woo.restRead } : {}),
      wooBillingWebhook: woo.billingWebhook,
      merchant,
      billing,
      wooInstallation: woo.installation,
    });
    const runtime = createApiRuntime(config, database, logger, handlers);
    registerShutdownHandlers(runtime);
    await runtime.start();
  } catch {
    logger.error("api.startup.failed", { reason: "configuration_or_initialization" });
    process.exitCode = 1;
  }
}

void main();
