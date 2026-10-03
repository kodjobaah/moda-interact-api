import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createDatabase } from "./database.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { createApiRuntime, registerShutdownHandlers } from "./server.js";
import { WooInstallationAuthenticator } from "./woocommerce/installation/authenticator.js";
import { WooInstallationConnectionService } from "./woocommerce/installation/connection-service.js";
import { createWooInstallationRoutes } from "./woocommerce/installation/routes.js";
import { WooSiteVerifier } from "./woocommerce/installation/site-verifier.js";

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
    const wooRoutes = createWooInstallationRoutes({
      mode: config.woocommerceConnectionMode,
      connectionService,
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