import { lookup as systemLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import type { SecureContextOptions } from "node:tls";
import { checkServerIdentity } from "node:tls";
import { randomSecret } from "./credential.js";
import { verifySiteProof } from "./credential.js";
import type { CanonicalWooSite, WooConnectionMode } from "./site-url.js";

const CHALLENGE_PATH = "/wp-json/moda-interact/v1/connection/challenge";
const DNS_DEADLINE_MS = 1500;
const TOTAL_DEADLINE_MS = 5000;
const RESPONSE_LIMIT_BYTES = 4096;

export class SiteVerificationError extends Error {
  readonly code:
    | "site_unreachable"
    | "site_address_rejected"
    | "site_response_rejected"
    | "site_proof_rejected";

  constructor(code: SiteVerificationError["code"]) {
    super(code);
    this.name = "SiteVerificationError";
    this.code = code;
  }
}

export interface SiteVerifierOptions {
  mode: WooConnectionMode;
  resolve?: (hostname: string) => Promise<readonly LookupAddress[]>;
  nonceFactory?: () => Buffer;
  timeoutMs?: number;
  ca?: SecureContextOptions["ca"];
}

interface ApprovedTarget {
  address: string;
  family: 4 | 6;
  approvedAddresses: Set<string>;
  local: boolean;
}

export class WooSiteVerifier {
  private readonly resolve: NonNullable<SiteVerifierOptions["resolve"]>;
  private readonly nonceFactory: NonNullable<SiteVerifierOptions["nonceFactory"]>;
  private readonly timeoutMs: number;

  constructor(private readonly options: SiteVerifierOptions) {
    this.resolve = options.resolve ?? ((hostname) => systemLookup(hostname, {
      all: true,
      verbatim: true,
    }));
    this.nonceFactory = options.nonceFactory ?? randomSecret;
    this.timeoutMs = Math.min(options.timeoutMs ?? TOTAL_DEADLINE_MS, TOTAL_DEADLINE_MS);
  }

  async verify(
    site: CanonicalWooSite,
    attemptId: string,
    bootstrapSecret: Uint8Array,
  ): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    const target = await this.approveTarget(site, deadline);
    const nonce = this.nonceFactory().toString("base64url");
    if (Buffer.from(nonce, "base64url").length !== 32) {
      throw new SiteVerificationError("site_response_rejected");
    }
    const callback = new URL(site.canonicalSiteUrl);
    callback.pathname = `${site.basePath}${CHALLENGE_PATH}`;
    callback.search = new URLSearchParams({ attempt_id: attemptId, nonce }).toString();
    const response = await this.requestChallenge(site, callback, target, deadline);

    if (
      response.attemptId !== attemptId ||
      response.nonce !== nonce ||
      !verifySiteProof(
        bootstrapSecret,
        attemptId,
        nonce,
        site.canonicalSiteUrl,
        response.proof,
      )
    ) {
      throw new SiteVerificationError("site_proof_rejected");
    }
  }

  private async approveTarget(
    site: CanonicalWooSite,
    deadline: number,
  ): Promise<ApprovedTarget> {
    if (this.options.mode === "public" && isIP(site.hostname) !== 0) {
      throw new SiteVerificationError("site_address_rejected");
    }

    let answers: readonly LookupAddress[];
    try {
      answers = await withDeadline(
        this.resolve(site.hostname),
        Math.min(DNS_DEADLINE_MS, Math.max(1, deadline - Date.now())),
      );
    } catch {
      throw new SiteVerificationError("site_unreachable");
    }
    if (answers.length === 0) throw new SiteVerificationError("site_address_rejected");
    if (answers.length > 64) throw new SiteVerificationError("site_address_rejected");

    const addresses = answers.map(({ address, family }) => {
      const actualFamily = isIP(address);
      if ((actualFamily !== 4 && actualFamily !== 6) || family !== actualFamily) {
        throw new SiteVerificationError("site_address_rejected");
      }
      return { address: normalizeAddress(address), family: actualFamily as 4 | 6 };
    });
    const allLocal = addresses.every(({ address }) => isLocalAddress(address));
    const allPublic = addresses.every(({ address }) => isPublicAddress(address));

    if (allLocal) {
      if (this.options.mode !== "local-development") throw new SiteVerificationError("site_address_rejected");
      if (site.protocol !== "http:" && site.protocol !== "https:") {
        throw new SiteVerificationError("site_address_rejected");
      }
    } else if (allPublic) {
      if (
        site.protocol !== "https:" ||
        isIP(site.hostname) !== 0 ||
        isExplicitLocalIdentity(site.hostname)
      ) {
        throw new SiteVerificationError("site_address_rejected");
      }
    } else {
      throw new SiteVerificationError("site_address_rejected");
    }

    const first = addresses[0];
    if (!first) throw new SiteVerificationError("site_address_rejected");
    return {
      ...first,
      approvedAddresses: new Set(addresses.map(({ address }) => address)),
      local: allLocal,
    };
  }

  private requestChallenge(
    site: CanonicalWooSite,
    callback: URL,
    target: ApprovedTarget,
    deadline: number,
  ): Promise<{ attemptId: string; nonce: string; proof: string }> {
    return new Promise((resolve, reject) => {
      const remaining = Math.max(1, deadline - Date.now());
      const request = (site.protocol === "https:" ? httpsRequest : httpRequest)({
        protocol: site.protocol,
        hostname: site.hostname,
        port: site.port,
        method: "GET",
        path: `${callback.pathname}${callback.search}`,
        agent: false,
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          connection: "close",
        },
        lookup: (_hostname, lookupOptions, callbackLookup) => {
          if (lookupOptions && typeof lookupOptions === "object" && lookupOptions.all) {
            callbackLookup(null, [{ address: target.address, family: target.family }]);
          } else {
            callbackLookup(null, target.address, target.family);
          }
        },
        ...(site.protocol === "https:"
          ? {
              servername: isIP(site.hostname) === 0 ? site.hostname : undefined,
              checkServerIdentity: (_hostname: string, certificate: Parameters<typeof checkServerIdentity>[1]) =>
                checkServerIdentity(site.hostname, certificate),
              ...(this.options.ca ? { ca: this.options.ca } : {}),
            }
          : {}),
      }, (response) => {
        const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        const contentEncoding = response.headers["content-encoding"];
        const contentLength = Number(response.headers["content-length"] ?? 0);
        if (
          response.statusCode !== 200 ||
          contentType !== "application/json" ||
          (contentEncoding !== undefined && contentEncoding !== "identity") ||
          !Number.isFinite(contentLength) ||
          contentLength > RESPONSE_LIMIT_BYTES
        ) {
          response.destroy();
          reject(new SiteVerificationError("site_response_rejected"));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > RESPONSE_LIMIT_BYTES) {
            response.destroy(new SiteVerificationError("site_response_rejected"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", () => reject(new SiteVerificationError("site_response_rejected")));
        response.on("end", () => {
          try {
            const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            if (body.includes("\0")) throw new Error("nul");
            const parsed: unknown = JSON.parse(body);
            if (!isChallengeResponse(parsed)) throw new Error("schema");
            resolve(parsed);
          } catch {
            reject(new SiteVerificationError("site_response_rejected"));
          }
        });
      });

      const timer = setTimeout(() => {
        request.destroy(new SiteVerificationError("site_unreachable"));
      }, remaining);
      const finish = () => clearTimeout(timer);
      request.once("close", finish);
      request.once("error", (error: unknown) => {
        finish();
        reject(error instanceof SiteVerificationError
          ? error
          : new SiteVerificationError("site_unreachable"));
      });
      request.once("socket", (socket) => {
        const event = site.protocol === "https:" ? "secureConnect" : "connect";
        socket.once(event, () => {
          if (!isApprovedPeerAddress(socket.remoteAddress, target.approvedAddresses)) {
            request.destroy(new SiteVerificationError("site_address_rejected"));
          }
        });
      });
      request.end();
    });
  }
}

function isChallengeResponse(
  value: unknown,
): value is { attemptId: string; nonce: string; proof: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 &&
    Object.keys(record).every((key) => ["attemptId", "nonce", "proof"].includes(key)) &&
    typeof record.attemptId === "string" &&
    typeof record.nonce === "string" &&
    typeof record.proof === "string";
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function isExplicitLocalIdentity(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isIP(hostname) !== 0;
}

export function isLocalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToBigInt(address);
    return inCidr(value, ipv4ToBigInt("10.0.0.0"), 8) ||
      inCidr(value, ipv4ToBigInt("172.16.0.0"), 12) ||
      inCidr(value, ipv4ToBigInt("192.168.0.0"), 16) ||
      inCidr(value, ipv4ToBigInt("127.0.0.0"), 8) ||
      inCidr(value, ipv4ToBigInt("169.254.0.0"), 16);
  }
  if (family === 6) {
    const value = ipv6ToBigInt(address);
    return value === 1n ||
      inCidr(value, ipv6ToBigInt("fc00::"), 7) ||
      inCidr(value, ipv6ToBigInt("fe80::"), 10);
  }
  return false;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToBigInt(address);
    const denied: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
      ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
      ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !denied.some(([network, prefix]) =>
      inCidr(value, ipv4ToBigInt(network), prefix),
    );
  }
  if (family === 6) {
    const value = ipv6ToBigInt(address);
    const mappedPrefix = ipv6ToBigInt("::ffff:0:0");
    const mapped = inCidr(value, mappedPrefix, 96);
    if (mapped) return false;
    return inCidr(value, ipv6ToBigInt("2000::"), 3) &&
      !inCidr(value, ipv6ToBigInt("2001::"), 23) &&
      !inCidr(value, ipv6ToBigInt("2001:db8::"), 32) &&
      !inCidr(value, ipv6ToBigInt("2002::"), 16) &&
      !inCidr(value, ipv6ToBigInt("3fff::"), 20);
  }
  return false;
}

function ipv4ToBigInt(address: string): bigint {
  return address.split(".").reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
}

function ipv6ToBigInt(address: string): bigint {
  const normalized = address.toLowerCase();
  const withoutMapped = normalized.includes(".")
    ? normalized.replace(/(\d+\.\d+\.\d+\.\d+)$/, (ipv4) => {
        const value = ipv4ToBigInt(ipv4);
        return `${Number((value >> 16n) & 0xffffn).toString(16)}:${Number(value & 0xffffn).toString(16)}`;
      })
    : normalized;
  const halves = withoutMapped.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const zeros = Math.max(0, 8 - left.length - right.length);
  const words = [...left, ...Array.from({ length: zeros }, () => "0"), ...right];
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word || "0"}`), 0n);
}

function inCidr(address: bigint, network: bigint, prefix: number): boolean {
  const bits = isBigIntV6(network, address) ? 128 : 32;
  const shift = BigInt(bits - prefix);
  return (address >> shift) === (network >> shift);
}

function isBigIntV6(left: bigint, right: bigint): boolean {
  return left > 0xffffffffn || right > 0xffffffffn;
}

function normalizeAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0] ?? "";
  return lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4
    ? lower.slice(7)
    : lower;
}

export function isApprovedPeerAddress(
  remoteAddress: string | undefined,
  approvedAddresses: ReadonlySet<string>,
): boolean {
  return remoteAddress !== undefined && approvedAddresses.has(normalizeAddress(remoteAddress));
}