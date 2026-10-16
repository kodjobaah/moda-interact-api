import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { ApiRouteHandler } from "../http/route-handler.js";
import type { WooInstallationAuthenticator } from "../auth/woo-installation/authenticator.js";
import { MerchantBootstrapReadService } from "../merchant/bootstrap/bootstrap-read.service.js";
import { createMerchantBootstrapRoute } from "../merchant/bootstrap/routes.js";
import { MerchantStoreContextService } from "../merchant/store-context/store-context.service.js";
import { createMerchantStoreContextRoute } from "../merchant/store-context/routes.js";
import { MerchantRecoverySummaryService } from "../merchant/recovery-summary/recovery-summary.service.js";
import { createMerchantRecoverySummaryRoute } from "../merchant/recovery-summary/routes.js";
import { MerchantRecoveryPolicyService } from "../merchant/recovery-policy/service.js";
import { createMerchantRecoveryPolicyRoute } from "../merchant/recovery-policy/routes.js";
import { MerchantRecoveryListService } from "../merchant/recoveries/list.service.js";
import { createMerchantRecoveriesRoute } from "../merchant/recoveries/routes.js";
import { MerchantRecoveryDetailService } from "../merchant/recoveries/detail/read.service.js";
import { createMerchantRecoveryDetailRoute } from "../merchant/recoveries/detail/routes.js";
import { MerchantDiscountOffersService } from "../merchant/discount-offers/service.js";
import { createMerchantDiscountOffersRoutes } from "../merchant/discount-offers/routes.js";
import { StoreCategoriesReadService, commerceEnvironmentForApi } from "../merchant/store-categories/store-categories-read.service.js";
import { createStoreCategoriesRoute } from "../merchant/store-categories/routes.js";
import { StoreCategorySelectionService } from "../merchant/store-categories/store-category-selection.service.js";
import { createStoreCategorySelectionRoute } from "../merchant/store-categories/selection-routes.js";

/** Assemble existing merchant-owned routes once; each route retains its own auth policy. */
export function createMerchantRoutes(options: {
  prisma: PrismaClient;
  authenticator: WooInstallationAuthenticator;
  logger: StructuredLogger;
  environment: string;
}): readonly ApiRouteHandler[] {
  const { prisma, authenticator, logger, environment } = options;
  const commerceEnvironment = commerceEnvironmentForApi(environment);
  return [
    createMerchantRecoverySummaryRoute({
      service: new MerchantRecoverySummaryService(prisma), authenticator, logger,
    }),
    createMerchantRecoveryPolicyRoute({
      service: new MerchantRecoveryPolicyService(prisma), authenticator, logger,
    }),
    createMerchantRecoveriesRoute({
      service: new MerchantRecoveryListService(prisma), authenticator, logger,
    }),
    createMerchantRecoveryDetailRoute({
      service: new MerchantRecoveryDetailService(prisma), authenticator, logger,
    }),
    createMerchantDiscountOffersRoutes({
      service: new MerchantDiscountOffersService(prisma), authenticator, logger,
    }),
    createStoreCategoriesRoute({
      service: new StoreCategoriesReadService(prisma, commerceEnvironment), authenticator, logger,
    }),
    createStoreCategorySelectionRoute({
      service: new StoreCategorySelectionService(prisma, commerceEnvironment), authenticator, logger,
    }),
    createMerchantBootstrapRoute({
      service: new MerchantBootstrapReadService(prisma), authenticator, logger,
    }),
    createMerchantStoreContextRoute({
      service: new MerchantStoreContextService(prisma), authenticator, logger,
    }),
  ];
}
