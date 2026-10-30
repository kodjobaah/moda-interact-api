import { configurationError, type ApiConfigurationKey } from "./errors.js";

export type PlatformConfigurationRow = Readonly<{
  environment: string;
  key: string;
  version: number;
  value: unknown;
}>;

/** Prisma-compatible *read-only* port; never expose audit or a writer to the service. */
export interface ApiPlatformConfigurationDatabase {
  platformConfiguration: {
    findUnique(args: {
      where: { environment_key: { environment: string; key: string } };
      select: { environment: true; key: true; version: true; value: true };
    }): Promise<PlatformConfigurationRow | null>;
  };
}

const ENVIRONMENTS = new Set(["local", "test", "development", "staging", "production"]);

/** A trusted deployment identity is injected once by the server composition owner. */
export function assertApiDeploymentEnvironment(environment: string, key: ApiConfigurationKey): void {
  if (!ENVIRONMENTS.has(environment)) configurationError(key, "INVALID_ENVIRONMENT");
}

export async function readApiPlatformConfiguration(
  database: ApiPlatformConfigurationDatabase,
  environment: string,
  key: ApiConfigurationKey,
): Promise<PlatformConfigurationRow> {
  assertApiDeploymentEnvironment(environment, key);
  let row: PlatformConfigurationRow | null;
  try {
    // Deliberately no caching and no fallback to any other environment/key.
    row = await database.platformConfiguration.findUnique({
      where: { environment_key: { environment, key } },
      select: { environment: true, key: true, version: true, value: true },
    });
  } catch (error) {
    return configurationError(key, "DATABASE_UNAVAILABLE", error);
  }
  if (!row) configurationError(key, "MISSING");
  if (
    row.environment !== environment || row.key !== key ||
    !Number.isSafeInteger(row.version) || row.version < 1 || row.version > 2147483647
  ) configurationError(key, "INVALID_ROW");
  return row;
}
