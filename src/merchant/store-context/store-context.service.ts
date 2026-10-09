import type { PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import type { MerchantStoreContextSnapshot } from "./schema.js";

export type MerchantStoreContextDatabase = Pick<PrismaClient, "shop">;

export class MerchantStoreContextConflictError extends Error {
  constructor() {
    super("store_context_conflict");
    this.name = "MerchantStoreContextConflictError";
  }
}

/** Only the authenticated Woo Shop's four provider-neutral context columns are writable. */
export class MerchantStoreContextService {
  constructor(private readonly database: MerchantStoreContextDatabase) {}

  async update(principal: WooInstallationPrincipal, snapshot: MerchantStoreContextSnapshot): Promise<void> {
    const result = await this.database.shop.updateMany({
      where: {
        id: principal.shopId,
        domain: principal.canonicalSiteUrl,
        status: "ACTIVE",
        platform: "WOOCOMMERCE",
        shopifyShopId: null,
        // A reconnect/revoke between credential authentication and this write
        // cannot permit an old principal to update another installation's state.
        wooCommerceInstallation: {
          is: {
            id: principal.installationId,
            shopId: principal.shopId,
            canonicalSiteUrl: principal.canonicalSiteUrl,
            credentialVersion: principal.credentialVersion,
            status: "ACTIVE",
            revokedAt: null,
          },
        },
      },
      data: {
        storeLocale: snapshot.storeLocale,
        defaultLanguageTag: snapshot.languageTag,
        defaultTimeZone: snapshot.timeZone,
        defaultCountryCode: snapshot.countryCode,
      },
    });
    if (result.count !== 1) throw new MerchantStoreContextConflictError();
  }
}
