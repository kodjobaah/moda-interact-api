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
import { createWooCheckoutActivityRoute } from "../woocommerce/activity/routes.js";
import type { WooCheckoutPublisher } from "../woocommerce/activity/producer.js";
import type { WooOrderPublisher } from "../woocommerce/activity/order-producer.js";
import type { ApiPlatformConfigurationReader } from "../platform-configuration/service.js";
import { createWooConsentRoute } from "../woocommerce/consent/routes.js";
import { createWooConsentStatusRoute } from "../woocommerce/consent-status/routes.js";
import { WooConsentStatusService } from "../woocommerce/consent-status/service.js";
import { WooConsentService } from "../woocommerce/consent/service.js";
import { createWooShopBrandRoute } from "../woocommerce/shop-brand/routes.js";
import { WooShopBrandService } from "../woocommerce/shop-brand/service.js";
import { createWooRecoverySelectionRoute } from "../woocommerce/recovery-selection/routes.js";
import { WooRecoverySelectionService } from "../woocommerce/recovery-selection/service.js";
import { createWooRecoveryRestoreRoute } from "../woocommerce/recovery-restore/routes.js";
import { WooRecoveryRestoreService } from "../woocommerce/recovery-restore/service.js";
import { WooConfirmedSentOfferResolver } from "../woocommerce/recovery-restore/offer-resolver.js";

/** The Woo routes each retain their distinct connect, signed-webhook and callback trust boundaries. */
export function createWooRoutes(options: {
  prisma: PrismaClient;
  config: RuntimeConfig;
  authenticator: WooInstallationAuthenticator;
  logger: StructuredLogger;
  platformConfiguration?: ApiPlatformConfigurationReader;
  checkoutPublisher?: WooCheckoutPublisher;
  orderPublisher?: WooOrderPublisher;
}): { installation: ApiRouteHandler; billingWebhook: ApiRouteHandler; activity: ApiRouteHandler; consent: ApiRouteHandler; consentStatus: ApiRouteHandler; shopBrand: ApiRouteHandler; recoverySelection: ApiRouteHandler; recoveryRestore: ApiRouteHandler; restRead?: ApiRouteHandler } {
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
    ...(config.wooBilling ? { resolveApiSecret: async () => {
      if (!options.platformConfiguration) throw new Error("billing_configuration_unavailable");
      return (await options.platformConfiguration.requireWooBillingCredentials()).apiSecret;
    } } : {}),
    receiptService: new WooBillingWebhookReceiptService(prisma.wooCommerceBillingWebhookReceipt),
    logger,
  });
  const restRead = (config.wooRestReadPublicOrigin || config.wooRestReadAuthorization)
    ? createWooRestReadAuthorizationRoutes({
        authenticator,
        service: new WooReadAuthorizationService(
          prisma,
          config.wooRestReadPublicOrigin
            ? { publicOrigin: config.wooRestReadPublicOrigin,
                resolveSecurity: async () => {
                  if (!options.platformConfiguration) throw new Error("platform_configuration_unavailable");
                  return options.platformConfiguration.requireCommerceConnectionSecurity();
                } }
            : config.wooRestReadAuthorization!,
          config.woocommerceConnectionMode,
          new WooReadCredentialVerifier({ mode: config.woocommerceConnectionMode }),
        ),
        logger,
      })
    : undefined;
  const activity = createWooCheckoutActivityRoute({
    authenticator,
    publisher: options.checkoutPublisher ?? { async publish() { throw new Error("woo_checkout_redis_unavailable"); } },
    ...(options.orderPublisher ? { orderPublisher: options.orderPublisher } : {}),
    logger,
  });
  return {
    installation,
    activity,
    consent: createWooConsentRoute({ authenticator, service: new WooConsentService(prisma), logger }),
    consentStatus: createWooConsentStatusRoute({ authenticator, service: new WooConsentStatusService(prisma), logger }),
    shopBrand: createWooShopBrandRoute({ authenticator, service: new WooShopBrandService(prisma), logger }),
    recoverySelection: createWooRecoverySelectionRoute({
      authenticator, service: new WooRecoverySelectionService(prisma), logger,
    }),
    recoveryRestore: createWooRecoveryRestoreRoute({
      authenticator, service: new WooRecoveryRestoreService(
        prisma, new WooConfirmedSentOfferResolver(prisma, logger),
      ), logger,
    }),
    billingWebhook,
    ...(restRead ? { restRead } : {}),
  };
}
