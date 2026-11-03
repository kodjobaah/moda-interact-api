import { Prisma, type Prisma as PrismaTypes } from "@prisma/client";
import type { WooInstallationPrincipal } from "./principal.js";

export type CurrentWooMutationPrincipal = Readonly<{
  shopId: string;
  installationId: string;
  credentialVersion: number;
  canonicalSiteUrl: string;
  shopDomain: string;
  onboardingCompleted: boolean;
}>;

export class WooMutationPrincipalConflictError extends Error {
  readonly code = "woo_mutation_principal_stale" as const;

  constructor(options?: ErrorOptions) {
    super("woo_mutation_principal_stale", options);
    this.name = "WooMutationPrincipalConflictError";
  }
}

export async function requireCurrentWooMutationPrincipal(
  tx: PrismaTypes.TransactionClient,
  principal: WooInstallationPrincipal,
): Promise<CurrentWooMutationPrincipal> {
  const lockedShop = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `);
  if (lockedShop.length !== 1) throw new WooMutationPrincipalConflictError();

  const lockedInstallation = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "woocommerce"."WooCommerceInstallation"
    WHERE "id" = ${principal.installationId} FOR SHARE
  `);
  if (lockedInstallation.length !== 1) throw new WooMutationPrincipalConflictError();

  const [shop, installation] = await Promise.all([
    tx.shop.findUnique({
      where: { id: principal.shopId },
      select: {
        id: true,
        domain: true,
        platform: true,
        shopifyShopId: true,
        status: true,
        onboardingCompleted: true,
      },
    }),
    tx.wooCommerceInstallation.findUnique({
      where: { id: principal.installationId },
      select: {
        id: true,
        shopId: true,
        canonicalSiteUrl: true,
        credentialVersion: true,
        status: true,
        revokedAt: true,
      },
    }),
  ]);

  if (
    !shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
    shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE" ||
    !installation || installation.id !== principal.installationId || installation.shopId !== principal.shopId ||
    installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
    installation.credentialVersion !== principal.credentialVersion || installation.status !== "ACTIVE" ||
    installation.revokedAt !== null
  ) {
    throw new WooMutationPrincipalConflictError();
  }

  return {
    shopId: shop.id,
    installationId: installation.id,
    credentialVersion: installation.credentialVersion,
    canonicalSiteUrl: installation.canonicalSiteUrl,
    shopDomain: shop.domain,
    onboardingCompleted: shop.onboardingCompleted,
  };
}