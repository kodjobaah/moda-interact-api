import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { ApiRouteHandler } from "../http/route-handler.js";
import type { WooInstallationAuthenticator } from "../auth/woo-installation/authenticator.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { BillingPresentationReadService } from "../billing/presentation/billing-read.service.js";
import { BillingPlanCatalogueReadService } from "../billing/presentation/plan-catalogue-read.service.js";
import { createBillingReadRoutes } from "../billing/presentation/routes.js";
import { WooPurchaseHistoryReadService } from "../billing/purchase-history/service.js";
import { createWooPurchaseHistoryRoute } from "../billing/purchase-history/routes.js";
import { RecurringSubscriptionCommandService } from "../billing/commands/recurring-subscription-command.service.js";
import { RecoveryCreditPurchaseCommandService } from "../billing/commands/recovery-credit-purchase-command.service.js";
import { createBillingCommandRoutes } from "../billing/commands/routes.js";
import { WooBillingClient } from "../woocommerce/billing/woo-billing-client.js";
import type { ApiPlatformConfigurationReader } from "../platform-configuration/service.js";

/** Read and command routes use the same installed principal but retain independent request validation. */
export function createBillingRoutes(options: {
  prisma: PrismaClient;
  authenticator: WooInstallationAuthenticator;
  logger: StructuredLogger;
  wooBilling: RuntimeConfig["wooBilling"];
  platformConfiguration?: Pick<ApiPlatformConfigurationReader, "requireWooBillingCredentials">;
}): readonly ApiRouteHandler[] {
  const { prisma, authenticator, logger, wooBilling } = options;
  const resolveWooBillingClient = wooBilling ? async () => {
    if (!options.platformConfiguration) throw new Error("billing_configuration_unavailable");
    // Fetch one atomic credential pair on each command; no provider call inside a DB transaction.
    const credentials = await options.platformConfiguration.requireWooBillingCredentials();
    return new WooBillingClient({ ...wooBilling, ...credentials });
  } : undefined;
  return [
    createWooPurchaseHistoryRoute({
      authenticator, service: new WooPurchaseHistoryReadService(prisma), logger,
    }),
    createBillingReadRoutes({
      billingReadService: new BillingPresentationReadService(prisma),
      billingPlanCatalogueReadService: new BillingPlanCatalogueReadService(prisma, logger),
      authenticator,
      logger,
    }),
    createBillingCommandRoutes({
      ...(resolveWooBillingClient && wooBilling ? {
        recurringSubscriptionCommandService: new RecurringSubscriptionCommandService(
          prisma, resolveWooBillingClient, wooBilling.environment,
        ),
        recoveryCreditPurchaseCommandService: new RecoveryCreditPurchaseCommandService(
          prisma, resolveWooBillingClient, wooBilling.environment,
        ),
      } : {}),
      authenticator,
      logger,
    }),
  ];
}
