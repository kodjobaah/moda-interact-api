import type { IncomingMessage } from "node:http";
import type { PrismaClient } from "@prisma/client";
import { performance } from "node:perf_hooks";
import { constantTimeDigestMatches, decodeSecret, digestSecret } from "./credential.js";

export type WooAuthenticationDatabase = Pick<PrismaClient, "wooCommerceInstallation">;

export type { WooInstallationPrincipal } from "./principal.js";
import type { WooInstallationPrincipal } from "./principal.js";

export class WooUnauthenticatedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "WooUnauthenticatedError";
  }
}

export class WooInstallationAuthenticator {
  constructor(private readonly database: WooAuthenticationDatabase) {}

  async authenticate(request: IncomingMessage, options: {
    allowSuspendedShop?: boolean;
    /** Optional diagnostic hook for an authenticated route; not part of the auth decision. */
    onInstallationLookupMs?: (durationMs: number) => void;
  } = {}): Promise<WooInstallationPrincipal> {
    const installationId = readExactlyOneHeader(request, "x-moda-installation-id");
    const authorization = readExactlyOneHeader(request, "authorization");
    if (!installationId || !/^[A-Za-z0-9_-]{1,128}$/.test(installationId)) {
      throw new WooUnauthenticatedError();
    }
    const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    const rawCredential = bearer?.[1] ? decodeSecret(bearer[1]) : undefined;
    if (!rawCredential) throw new WooUnauthenticatedError();

    const lookupStartedAt = performance.now();
    const installation = await (async () => {
      try {
        return await this.database.wooCommerceInstallation.findUnique({
          where: { id: installationId },
          select: {
            id: true,
            shopId: true,
            canonicalSiteUrl: true,
            status: true,
            credentialDigest: true,
            credentialVersion: true,
            revokedAt: true,
            shop: { select: { status: true, platform: true, shopifyShopId: true } },
          },
        });
      } finally {
        options.onInstallationLookupMs?.(Math.max(0, Math.round((performance.now() - lookupStartedAt) * 100) / 100));
      }
    })();
    const digestMatches = installation
      ? constantTimeDigestMatches(digestSecret(rawCredential), installation.credentialDigest)
      : false;
    if (
      !installation ||
      installation.status !== "ACTIVE" ||
      installation.revokedAt !== null ||
      (installation.shop.status !== "ACTIVE" && !(options.allowSuspendedShop && installation.shop.status === "SUSPENDED")) ||
      installation.shop.platform !== "WOOCOMMERCE" ||
      installation.shop.shopifyShopId !== null ||
      !digestMatches
    ) {
      throw new WooUnauthenticatedError();
    }

    return {
      installationId: installation.id,
      shopId: installation.shopId,
      canonicalSiteUrl: installation.canonicalSiteUrl,
      credentialVersion: installation.credentialVersion,
    };
  }
}

function readExactlyOneHeader(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values.length === 1 ? values[0] : undefined;
}