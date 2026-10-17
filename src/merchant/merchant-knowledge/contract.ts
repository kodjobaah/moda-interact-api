import type {
  MerchantKnowledgeDataFormatKey, MerchantKnowledgePurposeKey,
} from "@modainteract/moda-interact-shared/merchant-knowledge";

export const MERCHANT_KNOWLEDGE_PATH = "/v1/merchant/merchant-knowledge";
export const MERCHANT_KNOWLEDGE_PAGE_SIZE = 100;

export class MerchantKnowledgeReadError extends Error {
  constructor(readonly status: 400 | 409 | 503, readonly code: "invalid_request" | "merchant_knowledge_integrity_invalid" | "merchant_knowledge_unavailable") {
    super(code);
  }
}

export interface MerchantKnowledgeCatalogueEntry {
  purpose: { key: MerchantKnowledgePurposeKey; displayName: string };
  dataFormat: {
    key: MerchantKnowledgeDataFormatKey;
    displayName: string;
    inputKind: "REMOTE_URL" | "UPLOAD";
    canonicalExtension: string | null;
    acceptedContentTypes: string[];
  };
}

export interface MerchantKnowledgeRevisionProjection {
  id: string;
  generation: number;
  reason: "CREATE" | "URL_CHANGE" | "FILE_REPLACE" | "REFRESH" | "REPROCESS" | "ENTITLEMENT_CHANGE";
  status: "PENDING" | "PROCESSING" | "ACTIVE" | "FAILED" | "SUPERSEDED";
  requestedUrl: string | null;
  resolvedUrl: string | null;
  contentUnits: number | null;
  truncated: boolean;
  fetchedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
  activeContentUnits: number | null;
  activeTruncated: boolean;
  activeFetchedAt: string | null;
}

export interface MerchantKnowledgeSourceProjection {
  id: string;
  name: string;
  purposeKey: MerchantKnowledgePurposeKey;
  purposeDisplayName: string;
  dataFormatKey: MerchantKnowledgeDataFormatKey;
  dataFormatDisplayName: string;
  uploadedFileName: string | null;
  languageTag: string;
  position: number;
  currentGeneration: number;
  currentlyPlanEntitled: boolean;
  processingEligible: boolean;
  dormantReason: "NO_CURRENT_PLAN" | "SOURCE_TYPE" | "SOURCE_COUNT" | "MERCHANT_DISABLED" | null;
  revision: MerchantKnowledgeRevisionProjection | null;
  activeRevision: { id: string; generation: number; contentUnits: number | null; truncated: boolean; fetchedAt: string | null } | null;
}

export interface MerchantKnowledgeReadResponse {
  schemaVersion: 1;
  state: "ENABLED" | "MERCHANT_DISABLED" | "PLAN_UNENTITLED";
  planEntitled: boolean;
  merchantEnabled: boolean;
  effectiveEnabled: boolean;
  maxKnowledgeSources: number;
  maxContentUnitsPerSource: number;
  maxUploadBytes: number;
  configuredCount: number;
  planEligibleSourceCount: number;
  defaultLanguageTag: string;
  supportedLanguageTags: readonly string[];
  catalogue: MerchantKnowledgeCatalogueEntry[];
  sources: MerchantKnowledgeSourceProjection[];
  nextPosition: number | null;
}
