import type { ApiRouteHandler } from "../http/route-handler.js";

/** Explicit order: provider callbacks before merchant bearer routes; Connect is last. */
export function composeApiRoutes(input: {
  wooRestRead?: ApiRouteHandler;
  wooBillingWebhook: ApiRouteHandler;
  wooActivity?: ApiRouteHandler;
  wooConsent?: ApiRouteHandler;
  wooConsentStatus?: ApiRouteHandler;
  wooShopBrand?: ApiRouteHandler;
  wooRecoverySelection?: ApiRouteHandler;
  wooRecoveryRestore?: ApiRouteHandler;
  merchant: readonly ApiRouteHandler[];
  billing: readonly ApiRouteHandler[];
  wooInstallation: ApiRouteHandler;
}): readonly ApiRouteHandler[] {
  return [
    ...(input.wooRestRead ? [input.wooRestRead] : []),
    input.wooBillingWebhook,
    ...(input.wooActivity ? [input.wooActivity] : []),
    ...(input.wooConsent ? [input.wooConsent] : []),
    ...(input.wooConsentStatus ? [input.wooConsentStatus] : []),
    ...(input.wooShopBrand ? [input.wooShopBrand] : []),
    ...(input.wooRecoverySelection ? [input.wooRecoverySelection] : []),
    ...(input.wooRecoveryRestore ? [input.wooRecoveryRestore] : []),
    ...input.merchant,
    ...input.billing,
    input.wooInstallation,
  ];
}
