import { loadWooBillingConfig, type WooBillingConfig } from "./woocommerce/billing/woo-billing-config.js";

export interface RuntimeConfig {
  databaseUrl: string;
  host: "0.0.0.0";
  port: number;
  environment: string;
  readinessTimeoutMs: number;
  woocommerceConnectionMode: "public" | "local-development";
  wooBilling: WooBillingConfig | null;
}

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = 3000;
const READINESS_TIMEOUT_MS = 2000;

export function loadRuntimeConfig(
  environment: RuntimeEnvironment,
): RuntimeConfig {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (
    parsedDatabaseUrl.protocol !== "postgres:" &&
    parsedDatabaseUrl.protocol !== "postgresql:"
  ) {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme");
  }

  const portValue = environment.PORT?.trim();
  const port = portValue ? Number(portValue) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }

  const environmentName = environment.NODE_ENV?.trim() || "development";
  const connectionMode =
    environment.MODA_WOOCOMMERCE_CONNECTION_MODE?.trim() || "public";
  if (connectionMode !== "public" && connectionMode !== "local-development") {
    throw new Error(
      "MODA_WOOCOMMERCE_CONNECTION_MODE must be public or local-development",
    );
  }
  if (connectionMode === "local-development" && environmentName === "production") {
    throw new Error(
      "MODA_WOOCOMMERCE_CONNECTION_MODE local-development is forbidden in production",
    );
  }

  const wooBilling = loadWooBillingConfig(environment);

  return {
    databaseUrl,
    host: "0.0.0.0",
    port,
    environment: environmentName,
    readinessTimeoutMs: READINESS_TIMEOUT_MS,
    woocommerceConnectionMode: connectionMode,
    wooBilling,
  };
}