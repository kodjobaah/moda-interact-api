import type { IncomingMessage } from "node:http";
import type { PrismaClient } from "@prisma/client";
import { constantTimeDigestMatches, decodeSecret, digestSecret } from "./credential.js";

export type WooAuthenticationDatabase = Pick<PrismaClient, "wooCommerceInstallation">;

export interface WooInstallationPrincipal {
  installationId: string;
  shopId: string;
  canonicalSiteUrl: string;
  credentialVersion: number;
}

export class WooUnauthenticatedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "WooUnauthenticatedError";
  }
}

export class WooInstallationAuthenticator {
  constructor(private readonly database: WooAuthenticationDatabase) {}

  async authenticate(request: IncomingMessage): Promise<WooInstallationPrincipal> {
    const installationId = readExactlyOneHeader(request, "x-moda-installation-id");
    const authorization = readExactlyOneHeader(request, "authorization");
    if (!installationId || !/^[A-Za-z0-9_-]{1,128}$/.test(installationId)) {
      throw new WooUnauthenticatedError();
    }
    const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    const rawCredential = bearer?.[1] ? decodeSecret(bearer[1]) : undefined;
    if (!rawCredential) throw new WooUnauthenticatedError();

    const installation = await this.database.wooCommerceInstallation.findUnique({
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
    const digestMatches = installation
      ? constantTimeDigestMatches(digestSecret(rawCredential), installation.credentialDigest)
      : false;
    if (
      !installation ||
      installation.status !== "ACTIVE" ||
      installation.revokedAt !== null ||
      installation.shop.status !== "ACTIVE" ||
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