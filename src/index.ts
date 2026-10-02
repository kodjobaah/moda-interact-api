import { createLogger } from "@modainteract/moda-interact-shared/logging";
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
    const runtime = createApiRuntime(config, database, logger);
    registerShutdownHandlers(runtime);
    await runtime.start();
  } catch {
    logger.error("api.startup.failed", { reason: "configuration_or_initialization" });
    process.exitCode = 1;
  }
}

void main();