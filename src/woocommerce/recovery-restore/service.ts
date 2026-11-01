import { createHash, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  WooCartRestoreSnapshotV1Schema,
  WooRestoreResolveResponseV1Schema,
  type WooRestoreResolveRequestV1,
  type WooRestoreResolveResponseV1,
} from "@modainteract/moda-interact-shared/woocommerce";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import type { ConfirmedWooSentOfferReader } from "./offer-resolver.js";

type Database = Pick<PrismaClient, "$queryRaw">;
type ResolvePrincipal = Pick<WooInstallationPrincipal, "installationId" | "shopId" | "canonicalSiteUrl" | "credentialVersion">;

interface RecoveryRow {
  checkoutRecoveryLifetimeDays: number | null;
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
  conversationId: string | null;
  shopDomain: string;
  shopStatus: string;
  shopPlatform: string;
  shopifyShopId: string | null;
  installationCanonicalSiteUrl: string;
  installationStatus: string;
  installationCredentialVersion: number;
  installationRevokedAt: Date | null;
}

export class WooRecoveryRestoreService {
  constructor(
    private readonly database: Database,
    private readonly offerReader: ConfirmedWooSentOfferReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve(
    principal: ResolvePrincipal,
    request: WooRestoreResolveRequestV1,
  ): Promise<WooRestoreResolveResponseV1 | null> {
    const recovery = await this.readRecovery(principal, request);
    const now = this.now();
    const lifetimeDays = validateRecoveryLifetimeDays(recovery.checkoutRecoveryLifetimeDays);
    if (!recovery.id || !this.isEligible(recovery, principal, request.token, now, lifetimeDays)) return null;

    const snapshot = WooCartRestoreSnapshotV1Schema.safeParse(recovery.wooRestoreSnapshot);
    if (!snapshot.success || snapshot.data.kind !== "supported") return null;

    const outreachOffer = await this.offerReader.read({
      shopId: recovery.shopId,
      recoveryId: recovery.id,
      generation: recovery.generation,
      conversationId: recovery.conversationId,
    });

    const current = await this.readRecovery(principal, request);
    const currentNow = this.now();
    const currentLifetimeDays = validateRecoveryLifetimeDays(current.checkoutRecoveryLifetimeDays);
    if (!current.id || current.id !== recovery.id || current.shopId !== recovery.shopId ||
      current.checkoutToken !== recovery.checkoutToken || current.generation !== recovery.generation ||
      current.conversationId !== recovery.conversationId ||
      !this.isEligible(current, principal, request.token, currentNow, currentLifetimeDays)) return null;

    const currentSnapshot = WooCartRestoreSnapshotV1Schema.safeParse(current.wooRestoreSnapshot);
    if (!currentSnapshot.success || currentSnapshot.data.kind !== "supported") return null;
    const response = WooRestoreResolveResponseV1Schema.safeParse({
      schemaVersion: "woo.restore.resolve.v1",
      status: "eligible",
      recoveryId: current.id,
      checkoutKey: current.checkoutToken,
      snapshot: currentSnapshot.data,
      outreachOffer,
    });
    return response.success ? response.data : null;
  }

  private async readRecovery(
    principal: ResolvePrincipal,
    request: WooRestoreResolveRequestV1,
  ): Promise<RecoveryRow> {
    const rows = await this.database.$queryRaw<RecoveryRow[]>(Prisma.sql`
      SELECT config."checkoutRecoveryLifetimeDays" AS "checkoutRecoveryLifetimeDays",
        cr."id", cr."shopId", cr."checkoutToken", cr."generation",
        cr."status"::text AS "status", cr."completedAt", cr."expiredAt",
        cr."lastExternalActivityAt", cr."checkoutUrl", cr."wooRestoreSnapshot",
        (SELECT conversation."id" FROM "whatsapp"."Conversation" conversation
          WHERE conversation."checkoutRecoveryId" = cr."id" LIMIT 1) AS "conversationId",
        s."domain" AS "shopDomain", s."status"::text AS "shopStatus",
        s."platform"::text AS "shopPlatform", s."shopifyShopId",
        i."canonicalSiteUrl" AS "installationCanonicalSiteUrl",
        i."status"::text AS "installationStatus", i."credentialVersion" AS "installationCredentialVersion",
        i."revokedAt" AS "installationRevokedAt"
      FROM (VALUES (1)) AS request_context("singleton")
      LEFT JOIN "public"."BackgroundRuntimeConfig" config ON config."id" = 'default'
      LEFT JOIN "commerce"."CheckoutRecovery" cr
        ON cr."id" = ${request.recoveryId}
        AND cr."shopId" = ${principal.shopId}
        AND cr."generation" = (
          SELECT MAX(latest."generation")
          FROM "commerce"."CheckoutRecovery" latest
          WHERE latest."shopId" = cr."shopId" AND latest."checkoutToken" = cr."checkoutToken"
        )
      LEFT JOIN "commerce"."Shop" s ON s."id" = cr."shopId"
      LEFT JOIN "woocommerce"."WooCommerceInstallation" i
        ON i."shopId" = s."id" AND i."id" = ${principal.installationId}
      LIMIT 1
    `);
    const recovery = rows[0];
    if (!recovery) throw new Error("Checkout recovery resolver query returned no configuration row.");
    return recovery;
  }

  private isEligible(
    recovery: RecoveryRow,
    principal: ResolvePrincipal,
    token: string,
    now: Date,
    lifetimeDays: number,
  ): boolean {
    return recovery.shopId === principal.shopId &&
      recovery.status !== "COMPLETED" && recovery.status !== "EXPIRED" && recovery.status !== "CANCELLED" &&
      ["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(recovery.status) &&
      recovery.completedAt === null && recovery.expiredAt === null &&
      isWithinRecoveryLifetime(recovery.lastExternalActivityAt, now, lifetimeDays) &&
      recovery.shopStatus === "ACTIVE" && recovery.shopPlatform === "WOOCOMMERCE" &&
      recovery.shopifyShopId === null && recovery.installationStatus === "ACTIVE" &&
      recovery.installationRevokedAt === null &&
      recovery.installationCredentialVersion === principal.credentialVersion &&
      recovery.installationCanonicalSiteUrl === principal.canonicalSiteUrl &&
      recovery.shopDomain === principal.canonicalSiteUrl &&
      tokenMatchesStoredUrl(token, recovery.checkoutUrl, recovery.id, principal.canonicalSiteUrl);
  }
}

function validateRecoveryLifetimeDays(value: number | null): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error("Invalid checkout recovery lifetime configuration.");
  }
  return value;
}

function isWithinRecoveryLifetime(activityAt: Date, now: Date, lifetimeDays: number): boolean {
  const activityMs = activityAt.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(activityMs) || !Number.isFinite(nowMs)) return false;

  const ageMs = BigInt(nowMs) - BigInt(activityMs);
  const permittedMs = BigInt(lifetimeDays) * 86_400_000n;
  return ageMs >= 0n && ageMs < permittedMs;
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