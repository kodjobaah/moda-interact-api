import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { WooUnauthenticatedError } from "../../auth/woo-installation/authenticator.js";
import {
  WooShopBrandHttpError, type ShopBrandRole, type WooBrandImage,
  type WooShopBrandResult, type WooShopBrandSnapshot,
} from "./contract.js";

type BrandDatabase = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;
type RecordValue = Record<string, unknown>;
type BrandRow = {
  id: string;
  brandName: string | null;
  logoUrl: string | null;
  logoAltText: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
  squareLogoUrl: string | null;
  squareLogoAltText: string | null;
  coverImageUrl: string | null;
  whatsAppMedia: unknown;
};
type ShopRow = {
  id: string; domain: string; platform: string; status: string; shopifyShopId: string | null;
};
type InstallationRow = {
  id: string; shopId: string; canonicalSiteUrl: string; credentialVersion: number;
  status: string; revokedAt: Date | null;
};
type Source = {
  url: string | null; reference: string | null; fingerprint: string | null;
  generation: number; observedAt: string;
};
type StoredRole = RecordValue & { source: Source };

const ROLES: readonly ShopBrandRole[] = ["LOGO", "SQUARE_LOGO", "COVER_IMAGE"];
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A short Shop row lock serialises first-writer insertions; installation is
 * revalidated under lock so revocation/rotation cannot race bearer auth. */
async function assertCurrentInstallation(tx: Tx, principal: WooInstallationPrincipal): Promise<void> {
  const shops = await tx.$queryRaw<ShopRow[]>(Prisma.sql`
    SELECT "id", "domain", "platform"::text AS "platform", "status"::text AS "status", "shopifyShopId"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `);
  const shop = shops[0];
  if (!shop || shop.domain !== principal.canonicalSiteUrl || shop.platform !== "WOOCOMMERCE" ||
    shop.status !== "ACTIVE" || shop.shopifyShopId !== null) throw new WooUnauthenticatedError();
  const installations = await tx.$queryRaw<InstallationRow[]>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "credentialVersion", "status"::text AS "status", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id" = ${principal.installationId} FOR SHARE
  `);
  const installation = installations[0];
  if (!installation || installation.shopId !== shop.id || installation.canonicalSiteUrl !== shop.domain ||
    installation.credentialVersion !== principal.credentialVersion || installation.status !== "ACTIVE" ||
    installation.revokedAt !== null) throw new WooUnauthenticatedError();
}

function storedRole(value: unknown): StoredRole | null {
  if (value === undefined) return null;
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.work)) {
    throw new Error("shop_brand_media_invalid");
  }
  const source = value.source;
  if (!Number.isSafeInteger(source.generation) || (source.generation as number) < 1 ||
    (source.url !== null && typeof source.url !== "string") ||
    (source.reference !== null && typeof source.reference !== "string") ||
    (source.fingerprint !== null && !/^sha256:[a-f0-9]{64}$/.test(String(source.fingerprint))) ||
    typeof source.observedAt !== "string" || !Number.isFinite(Date.parse(source.observedAt))) {
    throw new Error("shop_brand_media_invalid");
  }
  return value as StoredRole;
}

function readMedia(value: unknown): { root: RecordValue; roles: RecordValue; latest: number } {
  if (!isRecord(value)) throw new Error("shop_brand_media_invalid");
  if (!Object.keys(value).length) return { root: value, roles: {}, latest: -Infinity };
  if (value.schemaVersion !== 1 || !isRecord(value.roles)) throw new Error("shop_brand_media_invalid");
  let latest = -Infinity;
  for (const role of ROLES) {
    const previous = storedRole(value.roles[role]);
    if (previous) latest = Math.max(latest, Date.parse(previous.source.observedAt));
  }
  return { root: value, roles: value.roles, latest };
}

/** Source identity excludes presentation-only WordPress metadata.  The worker
 * rechecks same-URL bytes separately; a changed URL or attachment ref requeues. */
export function wooImageSource(image: WooBrandImage | null): Pick<Source, "url" | "reference" | "fingerprint"> {
  const url = image?.url ?? null;
  if (url === null) return { url: null, reference: null, fingerprint: null };
  const reference = image?.attachmentId ? `woocommerce:attachment:${image.attachmentId}` : null;
  const digest = createHash("sha256").update(JSON.stringify([url, reference]), "utf8").digest("hex");
  return { url, reference, fingerprint: `sha256:${digest}` };
}

/** Preserve unrelated roles/ready metadata, and only change a source generation
 * when its canonical URL/reference/fingerprint changes. */
function nextRole(current: StoredRole | null, image: WooBrandImage | null, observedAt: string): StoredRole {
  const source = wooImageSource(image);
  const previous = current?.source;
  if (previous && previous.url === source.url && previous.reference === source.reference &&
    previous.fingerprint === source.fingerprint) {
    return { ...current!, source: { ...previous, observedAt } };
  }
  const generation = (previous?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) throw new Error("shop_brand_media_generation_exhausted");
  return {
    ...(current ?? {}),
    source: { ...source, generation, observedAt },
    work: {
      status: source.url ? "PENDING" : "MISSING", attempts: 0, retryAfter: null,
      leaseOwner: null, leaseUntil: null, failureCode: null, lastCheckedAt: null,
    },
    // A prior READY object may be retained for historical tracking, but its
    // sourceGeneration/sourceFingerprint no longer match and it cannot be sent.
    ready: current?.ready ?? null,
  };
}

async function lockOrCreateBrand(tx: Tx, shopId: string): Promise<BrandRow> {
  const lock = () => tx.$queryRaw<BrandRow[]>(Prisma.sql`
    SELECT "id", "brandName", "logoUrl", "logoAltText", "logoWidth", "logoHeight",
      "squareLogoUrl", "squareLogoAltText", "coverImageUrl", "whatsAppMedia"
    FROM "commerce"."ShopBrand" WHERE "shopId" = ${shopId} FOR UPDATE
  `);
  let rows = await lock();
  if (!rows.length) {
    // The Shop FOR UPDATE lock serialises first insertions per shop. Prisma
    // supplies ShopBrand's application-generated cuid and FK-safe create.
    await tx.shopBrand.create({ data: { shopId } });
    rows = await lock();
  }
  if (rows.length !== 1 || !rows[0]) throw new Error("shop_brand_missing_after_create");
  return rows[0];
}

/** No provider calls or queue publication happen in this transaction. */
export class WooShopBrandService {
  constructor(private readonly database: BrandDatabase, private readonly now: () => Date = () => new Date()) {}

  async record(principal: WooInstallationPrincipal, snapshot: WooShopBrandSnapshot): Promise<WooShopBrandResult> {
    const observed = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(observed) || observed > this.now().getTime() + 5 * 60_000) {
      throw new WooShopBrandHttpError(400, "invalid_request");
    }
    return this.database.$transaction(async tx => {
      await assertCurrentInstallation(tx, principal);
      const brand = await lockOrCreateBrand(tx, principal.shopId);
      const media = readMedia(brand.whatsAppMedia);
      // Retry idempotency is the pair (observedAt, canonical source snapshot),
      // never the caller's eventId. A distinct snapshot at an identical instant
      // is ambiguous: fail closed instead of silently discarding a new source.
      if (observed < media.latest) return { status: "unchanged" };
      if (observed === media.latest) {
        const images: Record<ShopBrandRole, WooBrandImage | null> = {
          LOGO: snapshot.logo, SQUARE_LOGO: snapshot.siteIcon, COVER_IMAGE: snapshot.coverImage,
        };
        const sameSources = ROLES.every(role => {
          const previous = storedRole(media.roles[role])?.source;
          const candidate = wooImageSource(images[role]);
          return previous?.url === candidate.url && previous.reference === candidate.reference &&
            previous.fingerprint === candidate.fingerprint;
        });
        if (!sameSources || brand.brandName !== snapshot.brandName ||
          brand.logoAltText !== (snapshot.logo?.altText ?? null) ||
          brand.logoWidth !== (snapshot.logo?.width ?? null) ||
          brand.logoHeight !== (snapshot.logo?.height ?? null) ||
          brand.squareLogoAltText !== (snapshot.siteIcon?.altText ?? null)) {
          throw new WooShopBrandHttpError(400, "invalid_request");
        }
        return { status: "unchanged" };
      }
      const roles: RecordValue = { ...media.roles };
      const selected: Record<ShopBrandRole, WooBrandImage | null> = {
        LOGO: snapshot.logo, SQUARE_LOGO: snapshot.siteIcon, COVER_IMAGE: snapshot.coverImage,
      };
      for (const role of ROLES) {
        roles[role] = nextRole(storedRole(roles[role]), selected[role], snapshot.observedAt);
      }
      const nextMedia = { ...media.root, schemaVersion: 1, roles };
      const now = this.now();
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE "commerce"."ShopBrand" SET
          "brandName" = ${snapshot.brandName},
          "logoUrl" = ${snapshot.logo?.url ?? null},
          "logoAltText" = ${snapshot.logo?.altText ?? null},
          "logoWidth" = ${snapshot.logo?.width ?? null},
          "logoHeight" = ${snapshot.logo?.height ?? null},
          "squareLogoUrl" = ${snapshot.siteIcon?.url ?? null},
          "squareLogoAltText" = ${snapshot.siteIcon?.altText ?? null},
          "coverImageUrl" = ${snapshot.coverImage?.url ?? null},
          "whatsAppMedia" = CAST(${JSON.stringify(nextMedia)} AS jsonb),
          "fetchedAt" = ${new Date(observed)}, "lastRefreshedAt" = ${now}
        WHERE "id" = ${brand.id} AND "shopId" = ${principal.shopId}
      `);
      if (changed !== 1) throw new Error("shop_brand_update_failed");
      return { status: "updated" };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 });
  }
}
