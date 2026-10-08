import { Prisma, type PrismaClient } from "@prisma/client";
import type { CanonicalWooSite } from "./site-url.js";
import { digestSecret, encodeSecret, randomSecret } from "./credential.js";
import { SiteVerificationError, WooSiteVerifier } from "./site-verifier.js";
import {
  FreePlanConfigurationUnavailableError,
  InitialWooFreeActivationService,
  RetryFreeActivationTransactionError,
} from "../billing/initial-free-activation.service.js";

export type WooConnectionDatabase = Pick<PrismaClient, "$transaction" | "shop" | "wooCommerceInstallation">;

export interface WooConnectInput {
  site: CanonicalWooSite;
  attemptId: string;
  bootstrapSecret: Buffer;
}

export interface WooConnectResult {
  installationId: string;
  shopId: string;
  canonicalSiteUrl: string;
  credential: string;
  credentialVersion: number;
  connection: "CREATED" | "RECONNECTED";
}

export class WooConnectionConflictError extends Error {
  constructor() {
    super("connection_conflict");
    this.name = "WooConnectionConflictError";
  }
}

export class WooSiteControlRejectedError extends Error {
  constructor() {
    super("site_verification_failed");
    this.name = "WooSiteControlRejectedError";
  }
}

export class WooInstallationConnectionService {
  constructor(
    private readonly database: WooConnectionDatabase,
    private readonly verifier: WooSiteVerifier,
    private readonly now: () => Date = () => new Date(),
    private readonly issueCredential: () => Buffer = randomSecret,
    private readonly freeActivation: Pick<InitialWooFreeActivationService, "activate"> = new InitialWooFreeActivationService(),
  ) {}

  async connect(input: WooConnectInput): Promise<WooConnectResult> {
    const observed = await this.database.wooCommerceInstallation.findUnique({
      where: { canonicalSiteUrl: input.site.canonicalSiteUrl },
      select: {
        id: true,
        shopId: true,
        credentialVersion: true,
        shop: { select: { id: true, status: true, platform: true, shopifyShopId: true } },
      },
    });

    try {
      await this.verifier.verify(input.site, input.attemptId, input.bootstrapSecret);
    } catch (error) {
      if (error instanceof SiteVerificationError) throw new WooSiteControlRejectedError();
      throw error;
    }

    const rawCredential = this.issueCredential();
    if (rawCredential.length !== 32) throw new Error("credential_generation_failed");
    const credential = encodeSecret(rawCredential);
    const credentialDigest = Uint8Array.from(digestSecret(rawCredential));
    const issuedAt = this.now();

    try {
      if (!observed) {
        const created = await this.runTransaction(async (transaction) => {
          const shop = await transaction.shop.create({
            data: {
              domain: input.site.canonicalSiteUrl,
              platform: "WOOCOMMERCE",
              shopifyShopId: null,
              status: "ACTIVE",
            },
            select: { id: true },
          });
          await this.freeActivation.activate(transaction, shop.id);
          return transaction.wooCommerceInstallation.create({
            data: {
              shopId: shop.id,
              canonicalSiteUrl: input.site.canonicalSiteUrl,
              status: "ACTIVE",
              credentialDigest,
              credentialVersion: 1,
              credentialIssuedAt: issuedAt,
              revokedAt: null,
            },
            select: { id: true, shopId: true, credentialVersion: true },
          });
        });

        return {
          installationId: created.id,
          shopId: created.shopId,
          canonicalSiteUrl: input.site.canonicalSiteUrl,
          credential,
          credentialVersion: created.credentialVersion,
          connection: "CREATED",
        };
      }

      const reconnected = await this.runTransaction(async (transaction) => {
        const shop = await transaction.shop.findUnique({
          where: { id: observed.shop.id },
          select: { id: true, status: true, platform: true, shopifyShopId: true },
        });
        if (!shop || shop.status === "SUSPENDED" || shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null) {
          throw new WooConnectionConflictError();
        }

        await this.freeActivation.activate(transaction, shop.id);

        const updated = await transaction.wooCommerceInstallation.updateMany({
          where: {
            id: observed.id,
            shopId: observed.shopId,
            credentialVersion: observed.credentialVersion,
          },
          data: {
            credentialDigest,
            credentialVersion: { increment: 1 },
            credentialIssuedAt: issuedAt,
            status: "ACTIVE",
            revokedAt: null,
          },
        });
        if (updated.count !== 1) throw new WooConnectionConflictError();

        if (shop.status === "UNINSTALLED") {
          const restored = await transaction.shop.updateMany({
            where: { id: shop.id, status: "UNINSTALLED" },
            data: { status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null },
          });
          if (restored.count !== 1) throw new WooConnectionConflictError();
        }

        return transaction.wooCommerceInstallation.findUniqueOrThrow({
          where: { id: observed.id },
          select: { id: true, shopId: true, credentialVersion: true },
        });
      });

      return {
        installationId: reconnected.id,
        shopId: reconnected.shopId,
        canonicalSiteUrl: input.site.canonicalSiteUrl,
        credential,
        credentialVersion: reconnected.credentialVersion,
        connection: "RECONNECTED",
      };
    } catch (error) {
      if (
        error instanceof WooConnectionConflictError ||
        isPrismaError(error, "P2002") ||
        isPrismaError(error, "P2034")
      ) {
        throw new WooConnectionConflictError();
      }
      throw error;
    }
  }

  private async runTransaction<T>(
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.database.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable = error instanceof RetryFreeActivationTransactionError || isPrismaError(error, "P2034");
        if (retryable && attempt === 0) continue;
        if (error instanceof RetryFreeActivationTransactionError) {
          throw new FreePlanConfigurationUnavailableError("activation_retry_exhausted");
        }
        throw error;
      }
    }
    throw new FreePlanConfigurationUnavailableError("activation_retry_exhausted");
  }
}

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}