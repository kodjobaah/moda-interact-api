import { Prisma, type PrismaClient } from "@prisma/client";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { SupportUnavailableError } from "./contract.js";

export type SupportDatabase = Pick<PrismaClient, "$transaction">;
export type SupportTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;
type Shop = { id: string; domain: string; status: string; platform: string; shopifyShopId: string | null; defaultLanguageTag: string | null };
type Installation = { id: string; shopId: string; canonicalSiteUrl: string;
  status: string; credentialVersion: number; revokedAt: Date | null };

/** Recheck the principal in the same database transaction; serialize sends by
 * locking the Shop first, then prevent credential rotation with installation lock. */
export async function assertSupportInstallation(tx: SupportTransaction, principal: WooInstallationPrincipal,
  options: { write: boolean; allowSuspended: boolean }): Promise<Shop> {
  const shops = options.write ? await tx.$queryRaw<Shop[]>(Prisma.sql`
    SELECT "id", "domain", "status", "platform", "shopifyShopId", "defaultLanguageTag"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `) : await tx.$queryRaw<Shop[]>(Prisma.sql`
    SELECT "id", "domain", "status", "platform", "shopifyShopId", "defaultLanguageTag"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR SHARE
  `);
  const shop = shops[0];
  if (!shop || shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null ||
    shop.domain !== principal.canonicalSiteUrl ||
    (shop.status !== "ACTIVE" && !(options.allowSuspended && shop.status === "SUSPENDED"))) {
    if (shop?.status === "SUSPENDED" && !options.allowSuspended) throw new SupportUnavailableError();
    throw new WooUnauthenticatedError();
  }
  const installs = await tx.$queryRaw<Installation[]>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "status", "credentialVersion", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId} FOR SHARE
  `);
  const installation = installs[0];
  if (!installation || installation.shopId !== principal.shopId ||
    installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
    installation.credentialVersion !== principal.credentialVersion ||
    installation.status !== "ACTIVE" || installation.revokedAt !== null) throw new WooUnauthenticatedError();
  return shop;
}
