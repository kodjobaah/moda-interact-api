import {
  MerchantKnowledgeDataFormatKeySchema,
  MerchantKnowledgePurposeKeySchema,
} from "@modainteract/moda-interact-shared/merchant-knowledge";
import { ModaSupportedLanguageTagSchema } from "@modainteract/moda-interact-shared/internationalization";
import type { MerchantKnowledgeCatalogueEntry, MerchantKnowledgeSourceProjection } from "./contract.js";
import { MerchantKnowledgeReadError } from "./contract.js";

const corrupt = () => new MerchantKnowledgeReadError(503, "merchant_knowledge_unavailable");
const validText = (value: unknown, max: number): string => {
  if (typeof value !== "string" || value.length > max || value.length === 0) throw corrupt();
  return value;
};

/** Never expose signed query strings, URL userinfo, fragments or object-storage addresses. */
function publicWebUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
      /(?:^|\.)(?:r2\.cloudflarestorage\.com|r2\.dev)$/i.test(url.hostname)) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Failure payloads and provider diagnostics are not public error-code fields. */
function publicFailureCode(value: string | null): string | null {
  return value && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
}

export function projectCatalogue(row: {
  purpose: { key: string; displayName: string };
  dataFormat: { key: string; displayName: string; inputKind: string; canonicalExtension: string | null; acceptedContentTypes: unknown };
}): MerchantKnowledgeCatalogueEntry {
  const purpose = MerchantKnowledgePurposeKeySchema.safeParse(row.purpose.key);
  const format = MerchantKnowledgeDataFormatKeySchema.safeParse(row.dataFormat.key);
  const kinds = ["REMOTE_URL", "UPLOAD"];
  const contentTypes = row.dataFormat.acceptedContentTypes;
  if (!purpose.success || !format.success || !kinds.includes(row.dataFormat.inputKind) ||
    !Array.isArray(contentTypes) || contentTypes.length > 20 ||
    !contentTypes.every((v) => typeof v === "string" && v.length <= 128)) throw corrupt();
  if (row.dataFormat.canonicalExtension !== null && !/^\.[A-Za-z0-9]{1,15}$/.test(row.dataFormat.canonicalExtension)) throw corrupt();
  return {
    purpose: { key: purpose.data, displayName: validText(row.purpose.displayName, 160) },
    dataFormat: {
      key: format.data,
      displayName: validText(row.dataFormat.displayName, 160),
      inputKind: row.dataFormat.inputKind as "REMOTE_URL" | "UPLOAD",
      canonicalExtension: row.dataFormat.canonicalExtension,
      acceptedContentTypes: contentTypes as string[],
    },
  };
}

export interface SourceRow {
  id: string; name: string; languageTag: string; position: number; currentGeneration: number;
  purpose: { key: string; displayName: string; active: boolean };
  dataFormat: { key: string; displayName: string; active: boolean };
  revisions: Array<{
    id: string; generation: number;
    reason: NonNullable<MerchantKnowledgeSourceProjection["revision"]>["reason"];
    status: "PENDING" | "PROCESSING" | "ACTIVE" | "FAILED" | "SUPERSEDED";
    requestedUrl: string | null; resolvedUrl: string | null; contentUnits: number | null; truncated: boolean;
    fetchedAt: Date | null; completedAt: Date | null; failureCode: string | null;
    uploadedAsset: { originalFileName: string } | null;
  }>;
}
export interface ActiveRevisionRow {
  id: string; sourceId: string; generation: number; contentUnits: number | null; truncated: boolean; fetchedAt: Date | null;
}

export function projectSource(
  source: SourceRow,
  allowed: ReadonlySet<string>,
  entitled: boolean,
  merchantEnabled: boolean,
  withinAllowance: boolean,
  active: ActiveRevisionRow | undefined,
): MerchantKnowledgeSourceProjection {
  const purpose = MerchantKnowledgePurposeKeySchema.safeParse(source.purpose.key);
  const format = MerchantKnowledgeDataFormatKeySchema.safeParse(source.dataFormat.key);
  const language = ModaSupportedLanguageTagSchema.safeParse(source.languageTag);
  if (!purpose.success || !format.success || !language.success || !Number.isSafeInteger(source.position) ||
    source.position < 0 || !Number.isSafeInteger(source.currentGeneration) || source.currentGeneration < 0 ||
    source.revisions.length > 1) throw corrupt();
  const latest = source.revisions[0] ?? null;
  if ((latest && latest.generation !== source.currentGeneration) || (!latest && source.currentGeneration !== 0)) throw corrupt();
  const typeAllowed = source.purpose.active && source.dataFormat.active &&
    allowed.has(`${purpose.data}\u0000${format.data}`);
  const currentlyPlanEntitled = entitled && typeAllowed && withinAllowance;
  const dormantReason = !entitled ? "NO_CURRENT_PLAN" : !typeAllowed ? "SOURCE_TYPE" :
    !withinAllowance ? "SOURCE_COUNT" : !merchantEnabled ? "MERCHANT_DISABLED" : null;
  const activeRevision = active ? { id: validText(active.id, 128), generation: active.generation,
    contentUnits: active.contentUnits, truncated: active.truncated,
    fetchedAt: active.fetchedAt?.toISOString() ?? null } : null;
  return {
    id: validText(source.id, 128), name: validText(source.name, 160),
    purposeKey: purpose.data, purposeDisplayName: validText(source.purpose.displayName, 160),
    dataFormatKey: format.data, dataFormatDisplayName: validText(source.dataFormat.displayName, 160),
    uploadedFileName: latest?.uploadedAsset ? validText(latest.uploadedAsset.originalFileName, 255) : null,
    languageTag: language.data, position: source.position, currentGeneration: source.currentGeneration,
    currentlyPlanEntitled, processingEligible: currentlyPlanEntitled && merchantEnabled,
    dormantReason,
    activeRevision,
    revision: latest ? {
      id: validText(latest.id, 128), generation: latest.generation, reason: latest.reason, status: latest.status,
      requestedUrl: format.data === "WEB_PAGE" ? publicWebUrl(latest.requestedUrl) : null,
      resolvedUrl: format.data === "WEB_PAGE" ? publicWebUrl(latest.resolvedUrl) : null,
      contentUnits: latest.contentUnits, truncated: latest.truncated,
      fetchedAt: latest.fetchedAt?.toISOString() ?? null, completedAt: latest.completedAt?.toISOString() ?? null,
      failureCode: publicFailureCode(latest.failureCode),
      activeContentUnits: active?.contentUnits ?? null,
      activeTruncated: active?.truncated ?? false,
      activeFetchedAt: active?.fetchedAt?.toISOString() ?? null,
    } : null,
  };
}
