import {
  CommerceEnvironment,
  Prisma,
  SubscriptionProjectionStatus,
  type PrismaClient,
} from "@prisma/client";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { categoryConflict, StoreCategorySelectionError } from "./selection-errors.js";
import { assertCategorySelectionStillCurrent, prepareCategorySelection } from "./selection-preparation.js";
import { publishCategorySelection } from "./selection-publication.js";
import type { StoreCategorySelectionRequest, StoreCategorySelectionResponse } from "./selection-schema.js";

export type CategorySelectionDatabase = Pick<PrismaClient, "$transaction" | "commercePromptTemplateCategory">;

interface ShopLockRow {
  id: string;
  domain: string;
  platform: string;
  shopifyShopId: string | null;
  status: string;
  onboardingCompleted: boolean;
}
interface InstallationLockRow {
  id: string;
  shopId: string;
  canonicalSiteUrl: string;
  credentialVersion: number;
  status: string;
  revokedAt: Date | null;
}

/** Locks the Shop and installation, so reconnect/revocation cannot race the publication. */
async function assertWooShopIsCurrent(tx: Prisma.TransactionClient, principal: WooInstallationPrincipal): Promise<void> {
  const shops = await tx.$queryRaw<ShopLockRow[]>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status", "onboardingCompleted"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `);
  const shop = shops[0];
  if (!shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
    shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE" ||
    !shop.onboardingCompleted) throw new StoreCategorySelectionError("store_category_integrity_invalid");

  const installations = await tx.$queryRaw<InstallationLockRow[]>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "credentialVersion", "status", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId} FOR SHARE
  `);
  const installation = installations[0];
  if (!installation || installation.id !== principal.installationId ||
    installation.shopId !== shop.id || installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
    installation.credentialVersion !== principal.credentialVersion ||
    installation.status !== "ACTIVE" || installation.revokedAt !== null) {
    throw new StoreCategorySelectionError("store_category_integrity_invalid");
  }
}

/** Woo Free is activated at Connect: select + publish must be one atomic POST. */
export class StoreCategorySelectionService {
  constructor(
    private readonly database: CategorySelectionDatabase,
    private readonly environment: CommerceEnvironment,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async select(
    principal: WooInstallationPrincipal,
    input: StoreCategorySelectionRequest,
  ): Promise<StoreCategorySelectionResponse> {
    const prepared = await prepareCategorySelection(this.database, input);
    try {
      return await this.database.$transaction(async (tx) => {
        await assertWooShopIsCurrent(tx, principal);
        const subscription = await tx.subscription.findUnique({
          where: { shopId: principal.shopId },
          select: { status: true, planId: true },
        });
        if (!subscription || !subscription.planId ||
          (subscription.status !== SubscriptionProjectionStatus.ACTIVE &&
           subscription.status !== SubscriptionProjectionStatus.TRIALING)) {
          throw new StoreCategorySelectionError("subscription_not_active");
        }

        let profile = await tx.commerceShopProfile.findUnique({ where: { shopId: principal.shopId } });
        if (!profile) {
          if (input.expectedPendingSelectionGeneration !== 0) throw categoryConflict();
          profile = await tx.commerceShopProfile.create({ data: { shopId: principal.shopId } });
        }
        if (profile.pendingSelectionGeneration !== input.expectedPendingSelectionGeneration ||
          !Number.isSafeInteger(profile.pendingSelectionGeneration) ||
          profile.pendingSelectionGeneration < 0 ||
          (profile.pendingPromptRevisionId === null &&
            (profile.pendingCategoryId !== null || profile.pendingSelectedAt !== null)) ||
          (profile.pendingPromptRevisionId !== null &&
            (profile.pendingCategoryId === null || profile.pendingSelectedAt === null))) throw categoryConflict();

        await assertCategorySelectionStillCurrent(tx, prepared);
        const now = this.now();
        const revisionId = await publishCategorySelection(
          tx, principal.shopId, this.environment, prepared, profile.pendingPromptRevisionId, now,
        );
        const updated = await tx.commerceShopProfile.updateMany({
          where: {
            shopId: principal.shopId,
            activeCategoryId: profile.activeCategoryId,
            pendingSelectionGeneration: input.expectedPendingSelectionGeneration,
            pendingCategoryId: profile.pendingCategoryId,
            pendingPromptRevisionId: profile.pendingPromptRevisionId,
          },
          data: {
            activeCategoryId: prepared.categoryId,
            activeCategoryActivatedAt: now,
            pendingCategoryId: null,
            pendingPromptRevisionId: null,
            pendingSelectedAt: null,
            pendingSelectionGeneration: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw categoryConflict();
        return {
          schemaVersion: 1 as const,
          activeCategoryId: prepared.categoryId,
          activePromptRevisionId: revisionId,
          activeMappingIds: prepared.selectedMappings.map((mapping) => mapping.id).sort(),
          pendingSelectionGeneration: input.expectedPendingSelectionGeneration + 1,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034"].includes(error.code)) throw categoryConflict();
      throw error;
    }
  }
}
