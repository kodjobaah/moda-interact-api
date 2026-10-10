import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { canonicalizeWooSiteUrl, type CanonicalWooSite, type WooConnectionMode } from "../installation/site-url.js";
import type { WooRestReadAuthorizationConfig } from "./config.js";
import { WooReadCredentialVerifier, WooReadVerificationError } from "./credential-verifier.js";
import { openWooReadCredentials, type WooRestReadCredential } from "./envelope.js";
import {
  prepareWooProductRequest, projectWooProducts, WooProductInputError, WooProductResponseError,
  type WooProductReadRequest, type WooProductReadOperation,
  type WooProductView,
} from "./product-operation.js";

/** Only trusted, already-authorised API service code may invoke this port. Never expose it as an HTTP proxy. */
export interface WooProductReadPort {
  read(shopId: string, operation: WooProductReadRequest): Promise<WooProductReadResult>;
}

export type WooProductReadFailure =
  | "invalid_operation" | "shop_unavailable" | "reauthorization_required"
  | "not_found" | "provider_forbidden" | "provider_unavailable" | "invalid_response";

export type WooProductReadResult =
  | { ok: true; operation: "products.list"; products: WooProductView[] }
  | { ok: true; operation: "products.retrieve"; product: WooProductView }
  | { ok: false; operation: WooProductReadOperation | "invalid"; reason: WooProductReadFailure };

export type WooProductReadDatabase = Pick<PrismaClient, "wooCommerceInstallation" | "wooCommerceRestReadGrant">;

/** Reuses API-007's DNS-pinned, peer-checked, bounded and no-redirect transport. */
export interface WooProductTransport {
  fetchProductOperation(site: CanonicalWooSite, credential: WooRestReadCredential, request: WooProductReadRequest): Promise<unknown>;
  verify(site: CanonicalWooSite, credential: WooRestReadCredential): Promise<void>;
}

interface SelectedGrant {
  id: string;
  installationId: string;
  shopId: string;
  authorizationAttemptId: string;
  credentialVersionSnapshot: number;
  rotationVersion: number;
  authorizedScope: string;
  status: string;
  credentialCiphertext: Uint8Array;
  credentialNonce: Uint8Array;
  credentialAuthTag: Uint8Array;
  encryptionKeyId: string;
}

/** Shop-scoped connection resolver. Neither the grant nor the decrypted keys escape read(). */
export class WooProductReadService implements WooProductReadPort {
  constructor(
    private readonly database: WooProductReadDatabase,
    private readonly config: Pick<WooRestReadAuthorizationConfig, "keys">,
    private readonly mode: WooConnectionMode,
    private readonly transport: WooProductTransport,
    private readonly logger: Pick<StructuredLogger, "info" | "warn">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(shopId: string, operation: WooProductReadRequest): Promise<WooProductReadResult> {
    let prepared: ReturnType<typeof prepareWooProductRequest>;
    try {
      prepared = prepareWooProductRequest(operation);
    } catch (error) {
      if (!(error instanceof WooProductInputError)) throw error;
      return this.finish(shopId, "invalid", "invalid_operation");
    }
    const name = prepared.operation;
    if (typeof shopId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(shopId)) {
      return this.finish(undefined, name, "shop_unavailable");
    }

    try {
      const installation = await this.database.wooCommerceInstallation.findUnique({
        where: { shopId },
        select: {
          id: true, shopId: true, canonicalSiteUrl: true, status: true, revokedAt: true, credentialVersion: true,
          shop: { select: { status: true, platform: true, shopifyShopId: true, domain: true } },
          restReadGrant: {
            select: {
              id: true, installationId: true, shopId: true, authorizationAttemptId: true,
              credentialVersionSnapshot: true, rotationVersion: true, authorizedScope: true,
              status: true, credentialCiphertext: true, credentialNonce: true,
              credentialAuthTag: true, encryptionKeyId: true,
            },
          },
        },
      });
      if (!installation || installation.shopId !== shopId || installation.status !== "ACTIVE" ||
        installation.revokedAt !== null || installation.shop.status !== "ACTIVE" ||
        installation.shop.platform !== "WOOCOMMERCE" || installation.shop.shopifyShopId !== null ||
        installation.shop.domain !== installation.canonicalSiteUrl) {
        return this.finish(shopId, name, "shop_unavailable");
      }
      const grant = installation.restReadGrant;
      if (!grant || grant.status !== "ACTIVE" || grant.authorizedScope !== "read" ||
        grant.shopId !== shopId || grant.installationId !== installation.id ||
        grant.credentialVersionSnapshot !== installation.credentialVersion) {
        return this.finish(shopId, name, "reauthorization_required");
      }
      const site = canonicalizeWooSiteUrl(installation.canonicalSiteUrl, this.mode);
      if (site.canonicalSiteUrl !== installation.canonicalSiteUrl) {
        return this.finish(shopId, name, "shop_unavailable");
      }

      // Ciphertext originates exclusively from DATABASE-003, never an external request.
      let credential: WooRestReadCredential;
      try {
        credential = openWooReadCredentials({
          credentialCiphertext: Buffer.from(grant.credentialCiphertext),
          credentialNonce: Buffer.from(grant.credentialNonce),
          credentialAuthTag: Buffer.from(grant.credentialAuthTag),
          encryptionKeyId: grant.encryptionKeyId,
        }, {
          shopId, installationId: installation.id, authorizationAttemptId: grant.authorizationAttemptId,
          credentialVersionSnapshot: grant.credentialVersionSnapshot,
        }, this.config);
      } catch {
        // Missing keyring versions or corrupted envelopes are operational problems,
        // not proof that the merchant revoked the provider key.
        return this.finish(shopId, name, "provider_unavailable");
      }

      let payload: unknown;
      try {
        payload = await this.transport.fetchProductOperation(site, credential, operation);
      } catch (error) {
        if (error instanceof WooReadVerificationError && error.reason === "rejected_credentials") {
          // A product-specific 403 is not sufficient proof of a revoked grant.
          // Verify the same read key against the neutral product-list endpoint first.
          try {
            await this.transport.verify(site, credential);
            return this.finish(shopId, name, "provider_forbidden");
          } catch (verificationError) {
            if (verificationError instanceof WooReadVerificationError &&
                verificationError.reason === "rejected_credentials") {
              await this.invalidateIfCurrent(grant);
              return this.finish(shopId, name, "reauthorization_required");
            }
            return this.finish(shopId, name, "provider_unavailable");
          }
        }
        return this.finish(shopId, name, classifyTransportFailure(error));
      }

      let product: WooProductView[] | WooProductView;
      try {
        product = projectWooProducts(payload, prepared);
      } catch (error) {
        if (!(error instanceof WooProductResponseError)) throw error;
        return this.finish(shopId, name, "invalid_response");
      }
      // A grant/installation revoked or rotated during network I/O must not yield data.
      const current = await this.database.wooCommerceInstallation.findUnique({
        where: { shopId },
        select: {
          id: true, shopId: true, canonicalSiteUrl: true, status: true, revokedAt: true, credentialVersion: true,
          shop: { select: { status: true, platform: true, shopifyShopId: true, domain: true } },
          restReadGrant: {
            select: { id: true, authorizationAttemptId: true, rotationVersion: true, status: true,
              authorizedScope: true, shopId: true, credentialVersionSnapshot: true },
          },
        },
      });
      if (!current || current.id !== installation.id || current.status !== "ACTIVE" ||
        current.revokedAt !== null || current.credentialVersion !== installation.credentialVersion ||
        current.canonicalSiteUrl !== installation.canonicalSiteUrl ||
        current.shop.domain !== current.canonicalSiteUrl || current.shopId !== shopId ||
        current.shop.status !== "ACTIVE" || current.shop.platform !== "WOOCOMMERCE" ||
        current.shop.shopifyShopId !== null || current.restReadGrant?.status !== "ACTIVE" ||
        current.restReadGrant.id !== grant.id ||
        current.restReadGrant.shopId !== shopId || current.restReadGrant.authorizedScope !== "read" ||
        current.restReadGrant.credentialVersionSnapshot !== installation.credentialVersion ||
        current.restReadGrant.authorizationAttemptId !== grant.authorizationAttemptId ||
        current.restReadGrant.rotationVersion !== grant.rotationVersion) {
        return this.finish(shopId, name, "reauthorization_required");
      }
      this.logger.info("woocommerce.rest_read.product", { shopId, operation: name, outcome: "success" });
      return name === "products.list"
        ? { ok: true, operation: "products.list", products: product as WooProductView[] }
        : { ok: true, operation: "products.retrieve", product: product as WooProductView };
    } catch {
      // Never surface provider errors, Prisma diagnostics, hostnames or secrets.
      return this.finish(shopId, name, "provider_unavailable");
    }
  }

  private async invalidateIfCurrent(grant: SelectedGrant): Promise<void> {
    try {
      await this.database.wooCommerceRestReadGrant.updateMany({
        where: {
          id: grant.id, installationId: grant.installationId, shopId: grant.shopId,
          authorizationAttemptId: grant.authorizationAttemptId,
          credentialVersionSnapshot: grant.credentialVersionSnapshot,
          rotationVersion: grant.rotationVersion, status: "ACTIVE",
        },
        data: { status: "INVALID", invalidatedAt: this.now() },
      });
    } catch {
      // A failed status update is never permission to retry with stale credentials.
      this.logger.warn("woocommerce.rest_read.invalidate.failed", { shopId: grant.shopId, reason: "update_failed" });
    }
  }

  private finish(
    shopId: string | undefined, operation: WooProductReadOperation | "invalid", reason: WooProductReadFailure,
  ): WooProductReadResult {
    this.logger.warn("woocommerce.rest_read.product", {
      ...(shopId ? { shopId } : {}), operation, outcome: reason,
    });
    return { ok: false, operation, reason };
  }
}

function classifyTransportFailure(error: unknown): WooProductReadFailure {
  if (!(error instanceof WooReadVerificationError)) return "provider_unavailable";
  switch (error.reason) {
    case "not_found": return "not_found";
    case "invalid_response": return "invalid_response";
    case "rejected_credentials": return "provider_forbidden";
    default: return "provider_unavailable";
  }
}

/** API-only factory: no public route, provider credentials or origin ever handed to callers. */
export function createWooProductReadPort(input: {
  database: WooProductReadDatabase;
  authorization: Pick<WooRestReadAuthorizationConfig, "keys">;
  mode: WooConnectionMode;
  logger: Pick<StructuredLogger, "info" | "warn">;
}): WooProductReadPort {
  return new WooProductReadService(
    input.database, input.authorization, input.mode,
    new WooReadCredentialVerifier({ mode: input.mode }), input.logger,
  );
}
