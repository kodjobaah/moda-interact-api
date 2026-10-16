import type { ApiRouteHandler } from "../http/route-handler.js";

/** Explicit order: provider callbacks before merchant bearer routes; Connect is last. */
export function composeApiRoutes(input: {
  wooRestRead?: ApiRouteHandler;
  wooBillingWebhook: ApiRouteHandler;
  merchant: readonly ApiRouteHandler[];
  billing: readonly ApiRouteHandler[];
  wooInstallation: ApiRouteHandler;
}): readonly ApiRouteHandler[] {
  return [
    ...(input.wooRestRead ? [input.wooRestRead] : []),
    input.wooBillingWebhook,
    ...input.merchant,
    ...input.billing,
    input.wooInstallation,
  ];
}
