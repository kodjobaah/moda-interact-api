import {
  MerchantAiResponseDelayReadV1Schema,
  MerchantAiResponseDelayWriteV1Schema,
  type MerchantAiResponseDelayReadV1,
  type MerchantAiResponseDelayWriteV1,
} from "@modainteract/moda-interact-shared/ai-response-delay";

export const MERCHANT_AI_RESPONSE_DELAY_PATH = "/v1/merchant/ai-response-delay";
export const MAX_AI_RESPONSE_DELAY_BODY_BYTES = 2048;

export class AiResponseDelayRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: "invalid_request" | "request_too_large") {
    super(code);
  }
}

export class AiResponseDelayConflictError extends Error {
  constructor() {
    super("ai_response_delay_conflict");
  }
}

export class AiResponseDelayUnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

export class AiResponseDelayIntegrityError extends Error {
  constructor() {
    super("ai_response_delay_integrity_invalid");
  }
}

export function parseAiResponseDelayWrite(input: unknown): MerchantAiResponseDelayWriteV1 {
  const parsed = MerchantAiResponseDelayWriteV1Schema.safeParse(input);
  if (!parsed.success || !validRevision(parsed.data.expectedRevision)) {
    throw new AiResponseDelayRequestError(400, "invalid_request");
  }
  return parsed.data;
}

export function isAiResponseDelayRead(input: unknown): input is MerchantAiResponseDelayReadV1 {
  if (!MerchantAiResponseDelayReadV1Schema.safeParse(input).success) return false;
  const value = input as MerchantAiResponseDelayReadV1;
  return validRevision(value.revision);
}

function validRevision(revision: string): boolean {
  return revision === "UNCONFIGURED" || Number.isFinite(Date.parse(revision));
}