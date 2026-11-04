import { sanitizeLogFields } from "@modainteract/moda-interact-shared/logging";
import type { WooBillingConfig } from "./woo-billing-config.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class WooBillingProviderError extends Error {
  readonly diagnostics: Readonly<Record<string, unknown>> | undefined;
  constructor(
    readonly outcome: "DEFINITE_REJECTION" | "OUTCOME_UNKNOWN",
    readonly safeCode: string,
    options?: ErrorOptions & { diagnostics?: Readonly<Record<string, unknown>> },
  ) {
    super(safeCode, options);
    this.diagnostics = options?.diagnostics;
    this.name = "WooBillingProviderError";
  }
}

export interface WooSubscriptionRequest {
  name: string;
  price: string;
  billing_period: "month";
  billing_interval: 1;
  return_url: string;
}

export interface WooSubscriptionResponse {
  id: string;
  confirmation_url: string;
}

export interface WooChargeRequest {
  name: string;
  price: string;
  return_url: string;
}

export class WooBillingClient {
  constructor(
    private readonly config: WooBillingConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  createSubscription(body: WooSubscriptionRequest): Promise<unknown> {
    return this.request("POST", "subscriptions", body);
  }

  createCharge(body: WooChargeRequest): Promise<unknown> {
    return this.request("POST", "charges", body);
  }

  switchSubscription(contractId: string, body: WooSubscriptionRequest): Promise<unknown> {
    return this.request("POST", `subscriptions/${encodeURIComponent(contractId)}`, body);
  }

  async cancelSubscription(contractId: string): Promise<void> {
    await this.request("DELETE", `subscriptions/${encodeURIComponent(contractId)}`);
  }

  private async request(method: "POST" | "DELETE", path: string, body?: WooSubscriptionRequest | WooChargeRequest): Promise<unknown> {
    const authorization = Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`, "utf8").toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.config.baseUrl), {
        method,
        headers: {
          authorization: `Basic ${authorization}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw this.failure("OUTCOME_UNKNOWN", "PROVIDER_TRANSPORT_ERROR", undefined, cause);
    }

    if (response.status < 200 || response.status >= 300) {
      const outcome = response.status < 300 || response.status >= 400 && response.status < 500 ? "DEFINITE_REJECTION" : "OUTCOME_UNKNOWN";
      const code = response.status >= 300 && response.status < 400 ? "PROVIDER_REDIRECT_REJECTED" :
        response.status >= 500 ? "PROVIDER_SERVER_ERROR" : "PROVIDER_REJECTED";
      let cause: unknown;
      let details: Record<string, unknown> = {};
      try {
        const bytes = await readBoundedResponse(response);
        if (/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const payload = value as Record<string, unknown>;
            details = {
              ...(typeof payload.code === "string" ? { upstreamCode: payload.code } : {}),
              ...(typeof payload.message === "string" ? { upstreamMessage: payload.message } : {}),
            };
          }
        }
      } catch (error) { cause = error; }
      throw this.failure(outcome, code, response.status, cause, details);
    }

    let bytes: Buffer;
    try {
      bytes = await readBoundedResponse(response);
    } catch (cause) {
      throw this.failure("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID", response.status, cause);
    }
    if (method === "DELETE" && bytes.length === 0) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw this.failure("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID", response.status);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (cause) {
      throw this.failure("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID", response.status, cause);
    }
  }
  private failure(
    outcome: "DEFINITE_REJECTION" | "OUTCOME_UNKNOWN",
    code: string,
    httpStatus?: number,
    cause?: unknown,
    details: Record<string, unknown> = {},
  ): WooBillingProviderError {
    // Provider-specific projection: never retain a response/body/header or URL
    // in emitted diagnostics. The original exception remains available as cause.
    const scrub = (value: string) => {
      let safe = value;
      for (const secret of [this.config.apiKey, this.config.apiSecret,
        Buffer.from(this.config.apiKey + ":" + this.config.apiSecret).toString("base64")]) {
        if (secret) safe = safe.split(secret).join("[REDACTED]");
      }
      return safe.replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED]").slice(0, 512);
    };
    const projected = Object.fromEntries(Object.entries(details).map(([key, value]) =>
      [key, typeof value === "string" ? scrub(value) : value]));
    const diagnostics = sanitizeLogFields({
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...projected,
      ...(cause instanceof Error ? {
        causeName: cause.name,
        // JSON parser errors may embed response contents; preserve the exception
        // but only emit its type, never the parser's body excerpt.
        ...(cause instanceof SyntaxError ? {} : { causeMessage: scrub(cause.message) }),
      } : {}),
    });
    return new WooBillingProviderError(outcome, code, { cause, diagnostics });
  }
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("provider_response_too_large");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("provider_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}