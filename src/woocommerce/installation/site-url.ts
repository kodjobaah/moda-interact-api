import { isIP } from "node:net";
import type { RuntimeConfig } from "../../runtime-config.js";

export type WooConnectionMode = RuntimeConfig["woocommerceConnectionMode"];

export interface CanonicalWooSite {
  canonicalSiteUrl: string;
  hostname: string;
  protocol: "http:" | "https:";
  port: number;
  basePath: string;
}

export class InvalidWooSiteUrlError extends Error {
  constructor() {
    super("invalid_site_url");
    this.name = "InvalidWooSiteUrlError";
  }
}

export function canonicalizeWooSiteUrl(
  input: string,
  mode: WooConnectionMode,
): CanonicalWooSite {
  if (Buffer.byteLength(input, "utf8") > 512 || input.includes("?") || input.includes("#")) {
    throw new InvalidWooSiteUrlError();
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidWooSiteUrlError();
  }

  const parsedHostname = url.hostname.toLowerCase();
  const hostname = (parsedHostname.startsWith("[") && parsedHostname.endsWith("]")
    ? parsedHostname.slice(1, -1)
    : parsedHostname).replace(/\.$/, "");
  const ipVersion = isIP(hostname);
  if (
    !hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(mode === "local-development" && url.protocol === "http:")) ||
    (url.protocol === "https:" && url.port !== "" && mode !== "local-development") ||
    (url.protocol === "http:" && url.port !== "" && mode !== "local-development")
  ) {
    throw new InvalidWooSiteUrlError();
  }

  if (mode === "public" && ipVersion !== 0) {
    throw new InvalidWooSiteUrlError();
  }

  if (!ipVersion && !isDnsHostname(hostname)) {
    throw new InvalidWooSiteUrlError();
  }

  const basePath = url.pathname.replace(/\/+$/, "");
  const canonicalHostname = ipVersion === 6 ? `[${hostname}]` : hostname;
  const canonicalSiteUrl = `${url.protocol}//${canonicalHostname}${url.port ? `:${url.port}` : ""}${basePath}`;
  if (Buffer.byteLength(canonicalSiteUrl, "utf8") > 512) {
    throw new InvalidWooSiteUrlError();
  }

  return {
    canonicalSiteUrl,
    hostname,
    protocol: url.protocol as CanonicalWooSite["protocol"],
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    basePath,
  };
}

function isDnsHostname(hostname: string): boolean {
  if (hostname.length > 253 || hostname.startsWith(".") || hostname.endsWith(".")) {
    return false;
  }
  return hostname.split(".").every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}