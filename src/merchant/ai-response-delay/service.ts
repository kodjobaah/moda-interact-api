import { Prisma, type PrismaClient, type ShopSettings } from "@prisma/client";
import type { MerchantAiResponseDelayReadV1, MerchantAiResponseDelayWriteV1 } from "@modainteract/moda-interact-shared/ai-response-delay";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import {
  AiResponseDelayConflictError,
  AiResponseDelayIntegrityError,
  AiResponseDelayUnauthorizedError,
} from "./contract.js";

type Database = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;

interface ShopIdentity {
  id: string;
  domain: string;
  platform: string;
  shopifyShopId: string | null;
  status: string;
  onboardingCompleted: boolean;
}

interface InstallationIdentity {
  id: string;
  shopId: string;
  canonicalSiteUrl: string;
  credentialVersion: number;
  status: string;
  revokedAt: Date | null;
}

async function assertCurrentShop(tx: Tx, principal: WooInstallationPrincipal, lock: boolean): Promise<ShopIdentity> {
  const shops = lock ? await tx.$queryRaw<ShopIdentity[]>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status", "onboardingCompleted"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `) : await tx.$queryRaw<ShopIdentity[]>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status", "onboardingCompleted"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId}
  `);
  const shop = shops[0];
  if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
    shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE") {
    throw new AiResponseDelayUnauthorizedError();
  }

  const installations = lock ? await tx.$queryRaw<InstallationIdentity[]>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "credentialVersion", "status", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId} FOR SHARE
  `) : await tx.$queryRaw<InstallationIdentity[]>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "credentialVersion", "status", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId}
  `);
  const installation = installations[0];
  if (!installation || installation.id !== principal.installationId || installation.shopId !== shop.id ||
    installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
    installation.credentialVersion !== principal.credentialVersion ||
    installation.status !== "ACTIVE" || installation.revokedAt !== null) {
    throw new AiResponseDelayUnauthorizedError();
  }
  return shop;
}

function response(settings: ShopSettings | null): MerchantAiResponseDelayReadV1 {
  const revision = settings?.updatedAt.toISOString() ?? "UNCONFIGURED";
  const value = {
    schemaVersion: 1 as const,
    revision,
    aiResponseDelayMinutes: settings?.aiResponseDelayMinutes ?? 0,
  };
  if (value.aiResponseDelayMinutes < 0 || value.aiResponseDelayMinutes > 30 ||
    !Number.isInteger(value.aiResponseDelayMinutes) || (revision !== "UNCONFIGURED" && !Number.isFinite(Date.parse(revision)))) {
    throw new AiResponseDelayIntegrityError();
  }
  return value;
}

export class MerchantAiResponseDelayService {
  constructor(private readonly database: Database, private readonly now: () => Date = () => new Date()) {}

  async read(principal: WooInstallationPrincipal): Promise<MerchantAiResponseDelayReadV1> {
    return this.database.$transaction(async (tx) => {
      await assertCurrentShop(tx, principal, false);
      const settings = await tx.shopSettings.findUnique({ where: { shopId: principal.shopId } });
      return response(settings);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async update(principal: WooInstallationPrincipal, input: MerchantAiResponseDelayWriteV1): Promise<MerchantAiResponseDelayReadV1> {
    try {
      return await this.database.$transaction(async (tx) => {
        const shop = await assertCurrentShop(tx, principal, true);
        const current = await tx.shopSettings.findUnique({ where: { shopId: principal.shopId } });
        const currentResponse = response(current);
        if (currentResponse.revision !== input.expectedRevision) throw new AiResponseDelayConflictError();
        if (currentResponse.aiResponseDelayMinutes === input.aiResponseDelayMinutes) return currentResponse;

        const time = this.now();
        const updatedAt = new Date(Math.max(time.getTime(), (current?.updatedAt.getTime() ?? 0) + 1));
        const next = current
          ? await tx.shopSettings.update({
            where: { shopId: principal.shopId },
            data: { aiResponseDelayMinutes: input.aiResponseDelayMinutes, updatedAt },
          })
          : await tx.shopSettings.create({
            data: {
              shopId: principal.shopId,
              onboardingCompleted: shop.onboardingCompleted,
              recoveryDelayMinutes: 30,
              recoveryOfferMode: "NONE",
              fixedShopifyDiscountId: null,
              followUpEnabled: false,
              followUpDelayMinutes: null,
              notifyOnInitialRecoveryOutreach: false,
              aiResponseDelayMinutes: input.aiResponseDelayMinutes,
              updatedAt,
            },
          });
        return response(next);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
        throw new AiResponseDelayConflictError();
      }
      throw error;
    }
  }
}