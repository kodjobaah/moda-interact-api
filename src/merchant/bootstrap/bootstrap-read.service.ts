import type { PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { isMerchantBootstrapResponse, type MerchantBootstrapResponse } from "./schema.js";

export type MerchantBootstrapDatabase = Pick<PrismaClient, "shop">;

export class MerchantBootstrapIntegrityError extends Error {
  constructor() {
    super("merchant bootstrap integrity failure");
    this.name = "MerchantBootstrapIntegrityError";
  }
}

export class MerchantBootstrapReadService {
  constructor(private readonly database: MerchantBootstrapDatabase) {}

  async read(principal: WooInstallationPrincipal): Promise<MerchantBootstrapResponse> {
    const shop = await this.database.shop.findUnique({
      where: { id: principal.shopId },
      select: {
        id: true,
        domain: true,
        platform: true,
        shopifyShopId: true,
        status: true,
        onboardingCompleted: true,
        installedAt: true,
        storeLocale: true,
        defaultLanguageTag: true,
        defaultTimeZone: true,
        defaultCountryCode: true,
        commerceShopProfile: {
          select: {
            shopId: true,
            activeCategoryId: true,
            activeCategory: { select: { id: true, slug: true, displayName: true } },
            pendingCategoryId: true,
            pendingCategory: { select: { id: true, slug: true, displayName: true } },
            pendingSelectionGeneration: true,
            pendingSelectedAt: true,
          },
        },
      },
    });

    if (
      !shop ||
      shop.id !== principal.shopId ||
      shop.platform !== "WOOCOMMERCE" ||
      shop.shopifyShopId !== null ||
      shop.status !== "ACTIVE" ||
      shop.domain !== principal.canonicalSiteUrl
    ) throw new MerchantBootstrapIntegrityError();

    const profile = shop.commerceShopProfile;
    if (
      profile &&
      (profile.shopId !== shop.id ||
        (profile.activeCategoryId === null) !== (profile.activeCategory === null) ||
        (profile.activeCategoryId !== null && profile.activeCategory?.id !== profile.activeCategoryId) ||
        (profile.pendingCategoryId === null) !== (profile.pendingCategory === null) ||
        (profile.pendingCategoryId !== null && profile.pendingCategory?.id !== profile.pendingCategoryId))
    ) throw new MerchantBootstrapIntegrityError();

    const response: MerchantBootstrapResponse = {
      schemaVersion: 1,
      shop: {
        id: shop.id,
        platform: "WOOCOMMERCE",
        domain: shop.domain,
        onboardingCompleted: shop.onboardingCompleted,
        installedAt: shop.installedAt.toISOString(),
      },
      internationalContext: {
        storeLocale: shop.storeLocale,
        languageTag: shop.defaultLanguageTag,
        timeZone: shop.defaultTimeZone,
        countryCode: shop.defaultCountryCode,
      },
      storeProfile: {
        activeCategory: profile?.activeCategory ?? null,
        pendingCategory: profile?.pendingCategory ?? null,
        pendingSelectionGeneration: profile?.pendingSelectionGeneration ?? 0,
        pendingSelectedAt: profile?.pendingSelectedAt?.toISOString() ?? null,
      },
    };

    if (!isMerchantBootstrapResponse(response)) throw new MerchantBootstrapIntegrityError();
    return response;
  }
}