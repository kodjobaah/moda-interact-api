/** Keep a generic public error message while retaining the original cause for server-side diagnostics. */
export type ApiConfigurationKey =
  | "merchant.knowledge.r2"
  | "commerce.connectionKeys"
  | "messaging.meta"
  | "messaging.sender"
  | "woocommerce.billing";

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
  constructor(readonly key: ApiConfigurationKey, readonly code: ApiConfigurationErrorCode, cause?: unknown) {
    super(`API platform configuration ${key}: ${code}`, { cause });
    this.name = "ApiPlatformConfigurationError";
  }
}

export function configurationError(key: ApiConfigurationKey, code: ApiConfigurationErrorCode, cause?: unknown): never {
  throw new ApiPlatformConfigurationError(key, code, cause);
}
