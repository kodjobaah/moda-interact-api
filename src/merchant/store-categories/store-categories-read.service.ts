import { CommerceEnvironment, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { readSelectableCategories } from "./catalogue-read.js";
import { categoryPresentationLocale, StoreCategoryReadError } from "./locale.js";
import { readStoreCategoryProfile } from "./profile-read.js";
import type { StoreCategoriesReadResponse } from "./schema.js";

export type CategoryReadDatabase = Pick<PrismaClient,
  "shop" | "wooCommerceInstallation" | "commercePromptTemplateCategory" | "commerceShopProfile" | "commerceAgentConfiguration">;

/** One authenticated merchant read, with no Shop/profile/credit writes or transactions. */
export class StoreCategoriesReadService {
  constructor(private readonly database: CategoryReadDatabase, private readonly environment: CommerceEnvironment) {}

  async read(principal: WooInstallationPrincipal, requestedLocale?: string): Promise<StoreCategoriesReadResponse> {
    const locale = categoryPresentationLocale(requestedLocale);
    const [shop, installation] = await Promise.all([
      this.database.shop.findUnique({
        where: { id: principal.shopId },
        select: { id: true, domain: true, platform: true, shopifyShopId: true, status: true },
      }),
      this.database.wooCommerceInstallation.findUnique({
        where: { id: principal.installationId },
        select: {
          id: true, shopId: true, canonicalSiteUrl: true, credentialVersion: true,
          status: true, revokedAt: true,
        },
      }),
    ]);
    if (!shop || !installation || shop.id !== principal.shopId ||
      shop.domain !== principal.canonicalSiteUrl || shop.platform !== "WOOCOMMERCE" ||
      shop.shopifyShopId !== null || shop.status !== "ACTIVE" ||
      installation.id !== principal.installationId || installation.shopId !== principal.shopId ||
      installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
      installation.credentialVersion !== principal.credentialVersion ||
      installation.status !== "ACTIVE" || installation.revokedAt !== null) {
      throw new StoreCategoryReadError("store_category_integrity_invalid");
    }
    const [categories, storeProfile] = await Promise.all([
      readSelectableCategories(this.database, locale),
      readStoreCategoryProfile(this.database, principal.shopId, locale, this.environment),
    ]);
    return {
      schemaVersion: 1,
      requestedLocale: locale.requestedLocale,
      resolvedLocale: locale.resolvedLocale,
      categories,
      storeProfile,
    };
  }
}

export function commerceEnvironmentForApi(value: string): CommerceEnvironment {
  const selected = value.trim().toUpperCase();
  if (!(selected in CommerceEnvironment)) {
    throw new Error("Unsupported Commerce environment for merchant category catalogue");
  }
  return CommerceEnvironment[selected as keyof typeof CommerceEnvironment];
}
