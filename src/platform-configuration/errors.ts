/** Safe errors: never include a database payload, envelope, cause or key material. */
export type ApiConfigurationKey =
  | "merchant.knowledge.r2"
  | "commerce.connectionKeys"
  | "messaging.meta";

export type ApiConfigurationErrorCode =
  | "INVALID_ENVIRONMENT"
  | "DATABASE_UNAVAILABLE"
  | "MISSING"
  | "DISABLED"
  | "INVALID_ROW"
  | "INVALID_VALUE"
  | "INVALID_ENVELOPE"
  | "UNSEAL_FAILED";

export class ApiPlatformConfigurationError extends Error {
  constructor(readonly key: ApiConfigurationKey, readonly code: ApiConfigurationErrorCode) {
    super(`API platform configuration ${key}: ${code}`);
    this.name = "ApiPlatformConfigurationError";
  }
}

export function configurationError(key: ApiConfigurationKey, code: ApiConfigurationErrorCode): never {
  throw new ApiPlatformConfigurationError(key, code);
}
