import { lookup as systemLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { LookupAddress } from "node:dns";
import type { SecureContextOptions } from "node:tls";
import type { CanonicalWooSite, WooConnectionMode } from "../installation/site-url.js";
import { isApprovedPeerAddress, isLocalAddress, isPublicAddress } from "../installation/site-verifier.js";
import type { WooRestReadCredential } from "./envelope.js";
import { prepareWooProductRequest, type WooProductReadRequest } from "./product-operation.js";

const DNS_DEADLINE_MS = 1500;
const TOTAL_DEADLINE_MS = 5000;
const RESPONSE_LIMIT = 8192;

export class WooReadVerificationError extends Error {
  constructor(readonly reason: "unsafe_target" | "unreachable" | "rejected_credentials" | "invalid_response" | "not_found" | "provider_unavailable") {
    super(reason);
    this.name = "WooReadVerificationError";
  }
}

export interface WooReadVerificationOptions {
  mode: WooConnectionMode;
  resolve?: (hostname: string) => Promise<readonly LookupAddress[]>;
  timeoutMs?: number;
  ca?: SecureContextOptions["ca"];
}

/** Read a single bounded WooCommerce product ID with Basic auth against a DNS-pinned, verified origin. */
export class WooReadCredentialVerifier {
  private readonly resolve: NonNullable<WooReadVerificationOptions["resolve"]>;
  private readonly timeoutMs: number;
  constructor(private readonly options: WooReadVerificationOptions) {
    this.resolve = options.resolve ?? ((hostname) => systemLookup(hostname, { all: true, verbatim: true }));
    this.timeoutMs = Math.min(options.timeoutMs ?? TOTAL_DEADLINE_MS, TOTAL_DEADLINE_MS);
  }

  async verify(site: CanonicalWooSite, credential: WooRestReadCredential): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    const addresses = await this.approve(site, deadline);
    const selected = addresses[0];
    if (!selected) throw new WooReadVerificationError("unsafe_target");
    const path = `${site.basePath}/wp-json/wc/v3/products?per_page=1&_fields=id`;
    let data: unknown;
    try {
      data = await this.read(site, path, credential, selected, new Set(addresses.map((entry) => entry.address)), deadline);
    } catch (error) {
      // API-007 already treats a missing product-list endpoint as an invalid
      // Woo REST verification response, not as a missing individual product.
      if (error instanceof WooReadVerificationError && error.reason === "not_found") {
        throw new WooReadVerificationError("invalid_response");
      }
      throw error;
    }
    if (!Array.isArray(data) || data.length > 1 || data.some((item) =>
      !item || typeof item !== "object" || Array.isArray(item) ||
      !Number.isSafeInteger((item as Record<string, unknown>).id) || Number((item as Record<string, unknown>).id) <= 0
    )) {
      throw new WooReadVerificationError("invalid_response");
    }
  }

  /** The caller supplies a validated product operation, never a URL, method or headers. */
  async fetchProductOperation(
    site: CanonicalWooSite,
    credential: WooRestReadCredential,
    operation: WooProductReadRequest,
  ): Promise<unknown> {
    const request = prepareWooProductRequest(operation);
    const deadline = Date.now() + this.timeoutMs;
    const addresses = await this.approve(site, deadline);
    const selected = addresses[0];
    if (!selected) throw new WooReadVerificationError("unsafe_target");
    // No redirects, credential query-string fallback, arbitrary destinations or verbs.
    return this.read(
      site, `${site.basePath}${request.path}`, credential, selected,
      new Set(addresses.map((entry) => entry.address)), deadline, request.maxBytes,
    );
  }

  private async approve(site: CanonicalWooSite, deadline: number): Promise<Array<{ address: string; family: 4 | 6 }>> {
    if (this.options.mode === "public" && isIP(site.hostname) !== 0) {
      throw new WooReadVerificationError("unsafe_target");
    }
    let answers: readonly LookupAddress[];
    try {
      answers = await deadlinePromise(this.resolve(site.hostname), Math.min(DNS_DEADLINE_MS, Math.max(1, deadline - Date.now())));
    } catch {
      throw new WooReadVerificationError("unreachable");
    }
    if (answers.length === 0 || answers.length > 64) throw new WooReadVerificationError("unsafe_target");
    const normalized = answers.map(({ address, family }) => {
      const actualFamily = isIP(address);
      if (actualFamily !== family || (family !== 4 && family !== 6)) throw new WooReadVerificationError("unsafe_target");
      return { address: address.toLowerCase(), family: family as 4 | 6 };
    });
    const allLocal = normalized.every(({ address }) => isLocalAddress(address));
    const allPublic = normalized.every(({ address }) => isPublicAddress(address));
    if (allLocal && this.options.mode === "local-development") {
      return normalized;
    }
    if (
      !allPublic || site.protocol !== "https:" || site.port !== 443 ||
      isIP(site.hostname) !== 0 || site.hostname === "localhost" ||
      site.hostname.endsWith(".localhost") || site.hostname.endsWith(".local")
    ) {
      throw new WooReadVerificationError("unsafe_target");
    }
    return normalized;
  }

  private read(
    site: CanonicalWooSite,
    path: string,
    credential: WooRestReadCredential,
    selected: { address: string; family: 4 | 6 },
    addresses: ReadonlySet<string>,
    deadline: number,
    responseLimit = RESPONSE_LIMIT,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const remaining = Math.max(1, deadline - Date.now());
      const request = (site.protocol === "https:" ? httpsRequest : httpRequest)({
        protocol: site.protocol,
        hostname: site.hostname,
        port: site.port,
        method: "GET",
        path,
        agent: false,
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          authorization: `Basic ${Buffer.from(`${credential.consumerKey}:${credential.consumerSecret}`).toString("base64")}`,
          connection: "close",
        },
        lookup: (_hostname, options, callback) => {
          if (options && typeof options === "object" && options.all) {
            callback(null, [{ address: selected.address, family: selected.family }]);
          } else {
            callback(null, selected.address, selected.family);
          }
        },
        ...(site.protocol === "https:" ? {
          servername: isIP(site.hostname) === 0 ? site.hostname : undefined,
          checkServerIdentity: (_hostname: string, certificate: Parameters<typeof checkServerIdentity>[1]) =>
            checkServerIdentity(site.hostname, certificate),
          ...(this.options.ca ? { ca: this.options.ca } : {}),
        } : {}),
      }, (response) => {
        const type = response.headers["content-type"]?.split(";", 1)[0]?.toLowerCase().trim();
        const encoding = response.headers["content-encoding"];
        const rawLength = response.headers["content-length"];
        const length = rawLength === undefined ? 0 : Number(rawLength);
        if (response.statusCode === 401 || response.statusCode === 403) {
          response.destroy();
          reject(new WooReadVerificationError("rejected_credentials"));
          return;
        }
        if (response.statusCode === 404) {
          response.destroy();
          reject(new WooReadVerificationError("not_found"));
          return;
        }
        if (response.statusCode === 408 || response.statusCode === 429 ||
          (response.statusCode !== undefined && response.statusCode >= 500)) {
          response.destroy();
          reject(new WooReadVerificationError("provider_unavailable"));
          return;
        }
        if (response.statusCode !== 200 || type !== "application/json" ||
          (encoding !== undefined && encoding !== "identity") ||
          !Number.isInteger(length) || length < 0 || length > responseLimit) {
          response.destroy();
          reject(new WooReadVerificationError("invalid_response"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.length;
          if (total > responseLimit) {
            response.destroy(new WooReadVerificationError("invalid_response"));
            return;
          }
          chunks.push(bytes);
        });
        response.once("error", () => reject(new WooReadVerificationError("invalid_response")));
        response.once("end", () => {
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            if (text.includes("\0")) throw new Error("nul");
            resolve(JSON.parse(text) as unknown);
          } catch {
            reject(new WooReadVerificationError("invalid_response"));
          }
        });
      });
      const timer = setTimeout(() => request.destroy(new WooReadVerificationError("unreachable")), remaining);
      request.once("close", () => clearTimeout(timer));
      request.once("error", (error: unknown) => reject(error instanceof WooReadVerificationError
        ? error : new WooReadVerificationError("unreachable")));
      request.once("socket", (socket) => {
        socket.once(site.protocol === "https:" ? "secureConnect" : "connect", () => {
          if (!isApprovedPeerAddress(socket.remoteAddress, addresses)) {
            request.destroy(new WooReadVerificationError("unsafe_target"));
          }
        });
      });
      request.end();
    });
  }
}

function deadlinePromise<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), milliseconds);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
