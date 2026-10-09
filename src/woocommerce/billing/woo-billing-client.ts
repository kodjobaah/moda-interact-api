import type { WooBillingConfig } from "./woo-billing-config.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class WooBillingProviderError extends Error {
  constructor(
    readonly outcome: "DEFINITE_REJECTION" | "OUTCOME_UNKNOWN",
    readonly safeCode: string,
  ) {
    super(safeCode);
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

export class WooBillingClient {
  constructor(
    private readonly config: WooBillingConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  createSubscription(body: WooSubscriptionRequest): Promise<unknown> {
    return this.request("POST", "subscriptions", body);
  }

  switchSubscription(contractId: string, body: WooSubscriptionRequest): Promise<unknown> {
    return this.request("POST", `subscriptions/${encodeURIComponent(contractId)}`, body);
  }

  async cancelSubscription(contractId: string): Promise<void> {
    await this.request("DELETE", `subscriptions/${encodeURIComponent(contractId)}`);
  }

  private async request(method: "POST" | "DELETE", path: string, body?: WooSubscriptionRequest): Promise<unknown> {
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
    } catch {
      throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_TRANSPORT_ERROR");
    }

    if (response.status >= 300 && response.status < 400) {
      throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_REDIRECT_REJECTED");
    }
    if (response.status >= 500) {
      throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_SERVER_ERROR");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new WooBillingProviderError("DEFINITE_REJECTION", "PROVIDER_REJECTED");
    }

    let bytes: Buffer;
    try {
      bytes = await readBoundedResponse(response);
    } catch {
      throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID");
    }
    if (method === "DELETE" && bytes.length === 0) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID");
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new WooBillingProviderError("OUTCOME_UNKNOWN", "PROVIDER_RESPONSE_INVALID");
    }
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