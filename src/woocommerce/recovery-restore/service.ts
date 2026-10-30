import { createHash, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  WooCartRestoreSnapshotV1Schema,
  WooRestoreResolveResponseV1Schema,
  type WooRestoreResolveRequestV1,
  type WooRestoreResolveResponseV1,
} from "@modainteract/moda-interact-shared/woocommerce";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";

type Database = Pick<PrismaClient, "$queryRaw">;
type ResolvePrincipal = Pick<WooInstallationPrincipal, "installationId" | "shopId" | "canonicalSiteUrl" | "credentialVersion">;

interface RecoveryRow {
  id: string;
  shopId: string;
  checkoutToken: string;
  generation: number;
  status: string;
  completedAt: Date | null;
  expiredAt: Date | null;
  lastExternalActivityAt: Date;
  checkoutUrl: string | null;
  wooRestoreSnapshot: unknown;
  shopDomain: string;
  shopStatus: string;
  shopPlatform: string;
  shopifyShopId: string | null;
  installationCanonicalSiteUrl: string;
  installationStatus: string;
  installationCredentialVersion: number;
  installationRevokedAt: Date | null;
}

const MAX_RECOVERY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class WooRecoveryRestoreService {
  constructor(private readonly database: Database, private readonly now: () => Date = () => new Date()) {}

  async resolve(
    principal: ResolvePrincipal,
    request: WooRestoreResolveRequestV1,
  ): Promise<WooRestoreResolveResponseV1 | null> {
    const now = this.now();
    const rows = await this.database.$queryRaw<RecoveryRow[]>(Prisma.sql`
      SELECT cr."id", cr."shopId", cr."checkoutToken", cr."generation",
        cr."status"::text AS "status", cr."completedAt", cr."expiredAt",
        cr."lastExternalActivityAt", cr."checkoutUrl", cr."wooRestoreSnapshot",
        s."domain" AS "shopDomain", s."status"::text AS "shopStatus",
        s."platform"::text AS "shopPlatform", s."shopifyShopId",
        i."canonicalSiteUrl" AS "installationCanonicalSiteUrl",
        i."status"::text AS "installationStatus", i."credentialVersion" AS "installationCredentialVersion",
        i."revokedAt" AS "installationRevokedAt"
      FROM "commerce"."CheckoutRecovery" cr
      JOIN "commerce"."Shop" s ON s."id" = cr."shopId"
      JOIN "woocommerce"."WooCommerceInstallation" i ON i."shopId" = s."id"
      WHERE cr."id" = ${request.recoveryId}
        AND cr."shopId" = ${principal.shopId}
        AND i."id" = ${principal.installationId}
        AND cr."generation" = (
          SELECT MAX(latest."generation")
          FROM "commerce"."CheckoutRecovery" latest
          WHERE latest."shopId" = cr."shopId" AND latest."checkoutToken" = cr."checkoutToken"
        )
      LIMIT 1
    `);
    const recovery = rows[0];
    if (!recovery || !this.isEligible(recovery, principal, request.token, now)) return null;

    const snapshot = WooCartRestoreSnapshotV1Schema.safeParse(recovery.wooRestoreSnapshot);
    if (!snapshot.success || snapshot.data.kind !== "supported") return null;
    const response = WooRestoreResolveResponseV1Schema.safeParse({
      schemaVersion: "woo.restore.resolve.v1",
      status: "eligible",
      recoveryId: recovery.id,
      checkoutKey: recovery.checkoutToken,
      snapshot: snapshot.data,
      outreachOffer: { kind: "NONE", reason: "NO_CONFIRMED_OFFER" },
    });
    return response.success ? response.data : null;
  }

  private isEligible(
    recovery: RecoveryRow,
    principal: ResolvePrincipal,
    token: string,
    now: Date,
  ): boolean {
    const activityAt = recovery.lastExternalActivityAt.getTime();
    const nowAt = now.getTime();
    return recovery.shopId === principal.shopId &&
      recovery.status !== "COMPLETED" && recovery.status !== "EXPIRED" && recovery.status !== "CANCELLED" &&
      ["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(recovery.status) &&
      recovery.completedAt === null && recovery.expiredAt === null &&
      Number.isFinite(activityAt) && activityAt <= nowAt && activityAt >= nowAt - MAX_RECOVERY_AGE_MS &&
      recovery.shopStatus === "ACTIVE" && recovery.shopPlatform === "WOOCOMMERCE" &&
      recovery.shopifyShopId === null && recovery.installationStatus === "ACTIVE" &&
      recovery.installationRevokedAt === null &&
      recovery.installationCredentialVersion === principal.credentialVersion &&
      recovery.installationCanonicalSiteUrl === principal.canonicalSiteUrl &&
      recovery.shopDomain === principal.canonicalSiteUrl &&
      tokenMatchesStoredUrl(token, recovery.checkoutUrl, recovery.id, principal.canonicalSiteUrl);
  }
}

function tokenMatchesStoredUrl(
  submittedToken: string,
  storedUrl: string | null,
  recoveryId: string,
  canonicalSiteUrl: string,
): boolean {
  if (!storedUrl || Buffer.byteLength(storedUrl, "utf8") > 2048) return false;
  const site = canonicalSite(canonicalSiteUrl);
  if (!site) return false;

  let parsed: URL;
  try {
    parsed = new URL(storedUrl);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash ||
    parsed.origin !== site.origin || parsed.pathname !== site.restorePath ||
    parsed.searchParams.size !== 3 ||
    parsed.searchParams.getAll("moda_interact_resume").length !== 1 ||
    parsed.searchParams.get("moda_interact_resume") !== "1" ||
    parsed.searchParams.getAll("r").length !== 1 || parsed.searchParams.get("r") !== recoveryId ||
    parsed.searchParams.getAll("t").length !== 1
  ) return false;

  const storedToken = parsed.searchParams.get("t");
  if (!storedToken || !/^[A-Za-z0-9_-]{43}$/.test(storedToken) ||
    Buffer.from(storedToken, "base64url").toString("base64url") !== storedToken) return false;
  const submittedDigest = createHash("sha256").update(submittedToken, "utf8").digest();
  const storedDigest = createHash("sha256").update(storedToken, "utf8").digest();
  return timingSafeEqual(submittedDigest, storedDigest);
}

function canonicalSite(value: string): { origin: string; restorePath: string } | null {
  if (Buffer.byteLength(value, "utf8") > 512) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const basePath = parsed.pathname.replace(/\/+$/, "");
  if (`${parsed.origin}${basePath}` !== value) return null;
  return { origin: parsed.origin, restorePath: `${basePath}/` };
}