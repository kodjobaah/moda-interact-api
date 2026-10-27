import type { ApiRouteHandler } from "../http/route-handler.js";

/** Explicit order: provider callbacks before merchant bearer routes; Connect is last. */
export function composeApiRoutes(input: {
  wooRestRead?: ApiRouteHandler;
  wooBillingWebhook: ApiRouteHandler;
  wooActivity?: ApiRouteHandler;
  wooConsent?: ApiRouteHandler;
  wooShopBrand?: ApiRouteHandler;
  wooRecoverySelection?: ApiRouteHandler;
  merchant: readonly ApiRouteHandler[];
  billing: readonly ApiRouteHandler[];
  wooInstallation: ApiRouteHandler;
}): readonly ApiRouteHandler[] {
  return [
    ...(input.wooRestRead ? [input.wooRestRead] : []),
    input.wooBillingWebhook,
    ...(input.wooActivity ? [input.wooActivity] : []),
    ...(input.wooConsent ? [input.wooConsent] : []),
    ...(input.wooShopBrand ? [input.wooShopBrand] : []),
    ...(input.wooRecoverySelection ? [input.wooRecoverySelection] : []),
    ...input.merchant,
    ...input.billing,
    input.wooInstallation,
  ];
}
