import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalizeWooSiteUrl, type WooConnectionMode } from "../installation/site-url.js";
import { digestSecret } from "../installation/credential.js";
import type { WooInstallationPrincipal } from "../installation/authenticator.js";
import type { WooRestReadAuthorizationConfig } from "./config.js";
import { sealWooReadCredentials } from "./envelope.js";
import { WooReadCredentialVerifier, WooReadVerificationError } from "./credential-verifier.js";

const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
const TRANSACTION_TIMEOUT_MS = 6000;
const TRANSACTION_RETRIES = 3;
const CALLBACK_PATH = "/v1/woocommerce/read-authorizations/callback";
const RETURN_PATH = "/v1/woocommerce/read-authorizations/return";

export interface WooCallbackPayload {
  key_id: number;
  user_id: string;
  consumer_key: string;
  consumer_secret: string;
  key_permissions: "read";
}

export type WooGrantStatus = "CONNECTED" | "PENDING" | "NOT_CONNECTED" | "REAUTHORIZATION_REQUIRED";
export type WooReadAuthorizationDatabase = Pick<PrismaClient,
  "wooCommerceRestReadAttempt" | "wooCommerceRestReadGrant" | "$transaction"
>;

export class WooReadAuthorizationError extends Error {
  constructor(
    readonly status: number,
    readonly code: "invalid_attempt" | "attempt_expired" | "invalid_credentials" | "provider_unavailable" |
      "shop_unavailable" | "authorization_conflict" | "internal_error",
  ) {
    super(code);
    this.name = "WooReadAuthorizationError";
  }
}

export class WooReadAuthorizationService {
  constructor(
    private readonly database: WooReadAuthorizationDatabase,
    private readonly config: WooRestReadAuthorizationConfig,
    private readonly mode: WooConnectionMode,
    private readonly verifier: Pick<WooReadCredentialVerifier, "verify">,
    private readonly now: () => Date = () => new Date(),
    private readonly tokenFactory: () => Buffer = () => randomBytes(32),
  ) {}

  async start(principal: WooInstallationPrincipal): Promise<{
    schemaVersion: 1;
    authorizationUrl: string;
    expiresAt: string;
  }> {
    const site = canonicalizeWooSiteUrl(principal.canonicalSiteUrl, this.mode);
    const token = this.tokenFactory();
    if (token.length !== 32) throw new WooReadAuthorizationError(500, "internal_error");
    const now = this.now();
    const attempt = await this.database.wooCommerceRestReadAttempt.create({
      data: {
        installationId: principal.installationId,
        shopId: principal.shopId,
        credentialVersionSnapshot: principal.credentialVersion,
        tokenDigest: Uint8Array.from(digestSecret(token)),
        expiresAt: new Date(now.getTime() + ATTEMPT_LIFETIME_MS),
      },
      select: { id: true, expiresAt: true },
    }).catch(() => { throw new WooReadAuthorizationError(409, "shop_unavailable"); });

    const url = new URL(site.canonicalSiteUrl);
    url.pathname = `${site.basePath}/wc-auth/v1/authorize`;
    url.search = new URLSearchParams({
      app_name: "Moda Interact",
      scope: "read",
      user_id: attempt.id,
      return_url: `${this.config.publicOrigin}${RETURN_PATH}`,
      callback_url: `${this.config.publicOrigin}${CALLBACK_PATH}/${token.toString("base64url")}`,
    }).toString();
    return { schemaVersion: 1, authorizationUrl: url.toString(), expiresAt: attempt.expiresAt.toISOString() };
  }

  async status(principal: WooInstallationPrincipal): Promise<{
    schemaVersion: 1; status: WooGrantStatus; providerRevocationRequired: boolean;
  }> {
    const grant = await this.database.wooCommerceRestReadGrant.findUnique({
      where: { installationId: principal.installationId },
      select: { shopId: true, credentialVersionSnapshot: true, status: true },
    });
    if (grant?.shopId !== undefined && grant.shopId !== principal.shopId) {
      throw new WooReadAuthorizationError(403, "shop_unavailable");
    }
    if (grant?.status === "ACTIVE" && grant.credentialVersionSnapshot === principal.credentialVersion) {
      return { schemaVersion: 1, status: "CONNECTED", providerRevocationRequired: false };
    }
    const attempt = await this.database.wooCommerceRestReadAttempt.findFirst({
      where: { installationId: principal.installationId, shopId: principal.shopId },
      select: { status: true, expiresAt: true, credentialVersionSnapshot: true },
      orderBy: { attemptSequence: "desc" },
    });
    const pending = attempt?.status === "PENDING" && attempt.expiresAt > this.now() &&
      attempt.credentialVersionSnapshot === principal.credentialVersion;
    return {
      schemaVersion: 1,
      status: pending ? "PENDING" : grant ? "REAUTHORIZATION_REQUIRED" : "NOT_CONNECTED",
      providerRevocationRequired: grant?.status === "REVOKED",
    };
  }

  async revoke(principal: WooInstallationPrincipal): Promise<{
    schemaVersion: 1; status: "REVOKED"; providerRevocationRequired: true;
  }> {
    await serializableRetry(async () => this.database.$transaction(async (transaction) => {
      const now = this.now();
      // A callback prepared before revoke must not restore the grant afterwards.
      await transaction.wooCommerceRestReadAttempt.updateMany({
        where: {
          installationId: principal.installationId,
          shopId: principal.shopId,
          status: "PENDING",
          expiresAt: { gt: now },
        },
        data: { status: "FAILED", consumedAt: now, failureCode: "locally_revoked" },
      });
      await transaction.wooCommerceRestReadGrant.updateMany({
        where: { installationId: principal.installationId, shopId: principal.shopId, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: now },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: TRANSACTION_TIMEOUT_MS }));
    return { schemaVersion: 1, status: "REVOKED", providerRevocationRequired: true };
  }

  async callback(encodedToken: string, payload: WooCallbackPayload): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(encodedToken)) throw new WooReadAuthorizationError(404, "invalid_attempt");
    const token = Buffer.from(encodedToken, "base64url");
    if (token.length !== 32 || token.toString("base64url") !== encodedToken) {
      throw new WooReadAuthorizationError(404, "invalid_attempt");
    }
    const attempt = await this.database.wooCommerceRestReadAttempt.findUnique({
      where: { tokenDigest: Uint8Array.from(digestSecret(token)) },
      select: {
        id: true, shopId: true, installationId: true, status: true, attemptSequence: true,
        expiresAt: true, credentialVersionSnapshot: true,
        installation: {
          select: {
            shopId: true, canonicalSiteUrl: true, status: true, revokedAt: true, credentialVersion: true,
            shop: { select: { status: true, platform: true, shopifyShopId: true } },
          },
        },
      },
    });
    if (!attempt || payload.user_id !== attempt.id) throw new WooReadAuthorizationError(404, "invalid_attempt");
    // Provider retries after a successful commit are idempotent, but cannot rotate a grant.
    if (attempt.status === "SUCCEEDED") {
      const committed = await this.database.wooCommerceRestReadGrant.findUnique({
        where: { authorizationAttemptId: attempt.id }, select: { id: true },
      });
      if (committed) return;
      throw new WooReadAuthorizationError(409, "authorization_conflict");
    }
    if (attempt.status !== "PENDING" || attempt.expiresAt <= this.now()) {
      throw new WooReadAuthorizationError(410, "attempt_expired");
    }
    const installation = attempt.installation;
    if (
      installation.shopId !== attempt.shopId || installation.status !== "ACTIVE" ||
      installation.revokedAt !== null || installation.credentialVersion !== attempt.credentialVersionSnapshot ||
      installation.shop.status !== "ACTIVE" || installation.shop.platform !== "WOOCOMMERCE" ||
      installation.shop.shopifyShopId !== null
    ) {
      throw new WooReadAuthorizationError(409, "shop_unavailable");
    }
    const site = canonicalizeWooSiteUrl(installation.canonicalSiteUrl, this.mode);
    try {
      await this.verifier.verify(site, { consumerKey: payload.consumer_key, consumerSecret: payload.consumer_secret });
    } catch (error) {
      if (error instanceof WooReadVerificationError) {
        throw new WooReadAuthorizationError(
          error.reason === "rejected_credentials" || error.reason === "invalid_response" ? 422 : 503,
          error.reason === "rejected_credentials" || error.reason === "invalid_response" ? "invalid_credentials" : "provider_unavailable",
        );
      }
      throw new WooReadAuthorizationError(503, "provider_unavailable");
    }
    const context = {
      shopId: attempt.shopId,
      installationId: attempt.installationId,
      authorizationAttemptId: attempt.id,
      credentialVersionSnapshot: attempt.credentialVersionSnapshot,
    };
    const envelope = sealWooReadCredentials(
      { consumerKey: payload.consumer_key, consumerSecret: payload.consumer_secret }, context, this.config,
    );
    try {
      await serializableRetry(async () => this.database.$transaction(async (transaction) => {
        // Enforce exactly one usage of this bearer and the same installed generation.
        const changed = await transaction.wooCommerceRestReadAttempt.updateMany({
          where: { id: attempt.id, installationId: attempt.installationId,
            shopId: attempt.shopId, status: "PENDING", expiresAt: { gt: this.now() },
            credentialVersionSnapshot: attempt.credentialVersionSnapshot },
          data: { status: "SUCCEEDED", consumedAt: this.now() },
        });
        if (changed.count !== 1) throw new WooReadAuthorizationError(409, "authorization_conflict");
        const existing = await transaction.wooCommerceRestReadGrant.findUnique({
          where: { installationId: attempt.installationId },
          select: { authorizationAttemptSequence: true, rotationVersion: true },
        });
        if (existing && existing.authorizationAttemptSequence >= attempt.attemptSequence) {
          throw new WooReadAuthorizationError(409, "authorization_conflict");
        }
        const grant = {
          shopId: attempt.shopId,
          authorizationAttemptId: attempt.id,
          authorizationAttemptSequence: attempt.attemptSequence,
          credentialVersionSnapshot: attempt.credentialVersionSnapshot,
          credentialCiphertext: Uint8Array.from(envelope.credentialCiphertext),
          credentialNonce: Uint8Array.from(envelope.credentialNonce),
          credentialAuthTag: Uint8Array.from(envelope.credentialAuthTag),
          encryptionKeyId: envelope.encryptionKeyId,
          providerKeyId: String(payload.key_id),
          authorizedScope: "read",
          verifiedAt: this.now(),
          grantedAt: this.now(),
        };
        if (existing) {
          await transaction.wooCommerceRestReadGrant.update({
            where: { installationId: attempt.installationId },
            data: { ...grant, status: "ACTIVE", rotationVersion: existing.rotationVersion + 1,
              revokedAt: null, invalidatedAt: null },
          });
        } else {
          await transaction.wooCommerceRestReadGrant.create({
            data: { ...grant, installationId: attempt.installationId, status: "ACTIVE", rotationVersion: 1 },
          });
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: TRANSACTION_TIMEOUT_MS }));
    } catch (error) {
      if (error instanceof WooReadAuthorizationError) throw error;
      // DB guards enforce generation, replay and monotonic rotation. Never expose SQL details.
      throw new WooReadAuthorizationError(409, "authorization_conflict");
    }
  }
}

async function serializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let index = 0; index < TRANSACTION_RETRIES; index += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" &&
        index + 1 < TRANSACTION_RETRIES) continue;
      throw error;
    }
  }
  throw new WooReadAuthorizationError(409, "authorization_conflict");
}
