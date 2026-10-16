import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { ApiRouteHandler } from "../http/route-handler.js";
import type { RuntimeConfig } from "../runtime-config.js";
import type { WooInstallationAuthenticator } from "../auth/woo-installation/authenticator.js";
import { WooInstallationConnectionService } from "../woocommerce/installation/connection-service.js";
import { createWooInstallationRoutes } from "../woocommerce/installation/routes.js";
import { WooSiteVerifier } from "../woocommerce/installation/site-verifier.js";
import { WooBillingWebhookReceiptService } from "../woocommerce/billing/webhooks/webhook-receipt.service.js";
import { createWooBillingWebhookRoute } from "../woocommerce/billing/webhooks/woo-billing-webhook-route.js";
import { WooReadCredentialVerifier } from "../woocommerce/rest-read/credential-verifier.js";
import { WooReadAuthorizationService } from "../woocommerce/rest-read/authorization.service.js";
import { createWooRestReadAuthorizationRoutes } from "../woocommerce/rest-read/authorization.routes.js";

/** The Woo routes each retain their distinct connect, signed-webhook and callback trust boundaries. */
export function createWooRoutes(options: {
  prisma: PrismaClient;
  config: RuntimeConfig;
  authenticator: WooInstallationAuthenticator;
  logger: StructuredLogger;
}): { installation: ApiRouteHandler; billingWebhook: ApiRouteHandler; restRead?: ApiRouteHandler } {
  const { prisma, config, authenticator, logger } = options;
  const installation = createWooInstallationRoutes({
    mode: config.woocommerceConnectionMode,
    connectionService: new WooInstallationConnectionService(
      prisma, new WooSiteVerifier({ mode: config.woocommerceConnectionMode }),
    ),
    authenticator,
    logger,
  });
  const billingWebhook = createWooBillingWebhookRoute({
    ...(config.wooBilling ? { apiSecret: config.wooBilling.apiSecret } : {}),
    receiptService: new WooBillingWebhookReceiptService(prisma.wooCommerceBillingWebhookReceipt),
    logger,
  });
  const restRead = config.wooRestReadAuthorization
    ? createWooRestReadAuthorizationRoutes({
        authenticator,
        service: new WooReadAuthorizationService(
          prisma,
          config.wooRestReadAuthorization,
          config.woocommerceConnectionMode,
          new WooReadCredentialVerifier({ mode: config.woocommerceConnectionMode }),
        ),
        logger,
      })
    : undefined;
  return {
    installation,
    billingWebhook,
    ...(restRead ? { restRead } : {}),
  };
}
