import { createHash } from "node:crypto";

export class InvalidRecoveryDetailRequest extends Error {
  constructor() {
    super("invalid_request");
    this.name = "InvalidRecoveryDetailRequest";
  }
}

export type DetailSection = "messages" | "related";
export type DetailDirection = "first" | "latest" | "next" | "previous";
export interface DetailBoundary { at: Date; id: string }
export interface DetailNavigation {
  direction: DetailDirection;
  boundary: DetailBoundary | null;
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,191}$/;
const BASE64URL = /^[A-Za-z0-9_-]{1,1024}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function validRecoveryId(id: unknown): id is string {
  return typeof id === "string" && IDENTIFIER.test(id);
}

function cursorScope(shopId: string, recoveryId: string, kind: DetailSection): string {
  return createHash("sha256")
    .update(JSON.stringify(["woo-recovery-detail-v1", shopId, recoveryId, kind]))
    .digest("hex");
}

export function encodeDetailCursor(
  shopId: string,
  recoveryId: string,
  kind: DetailSection,
  direction: "previous" | "next",
  boundary: DetailBoundary,
): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    scope: cursorScope(shopId, recoveryId, kind),
    direction,
    id: boundary.id,
    at: boundary.at.toISOString(),
  }), "utf8").toString("base64url");
}

/** Cursors are resource-bound navigation positions; shop authorization is checked separately. */
export function parseDetailNavigation(
  shopId: string,
  recoveryId: string,
  kind: DetailSection,
  params: URLSearchParams,
): DetailNavigation {
  if (!validRecoveryId(shopId) || !validRecoveryId(recoveryId)) {
    throw new InvalidRecoveryDetailRequest();
  }
  const validKeys = new Set(["cursor", ...(kind === "messages" ? ["window"] : [])]);
  for (const key of params.keys()) {
    if (!validKeys.has(key) || params.getAll(key).length !== 1) {
      throw new InvalidRecoveryDetailRequest();
    }
  }
  const cursor = params.get("cursor");
  const window = params.get("window");
  if (cursor === null) {
    if (window === null || window === "first") return { direction: "first", boundary: null };
    if (kind === "messages" && window === "latest") return { direction: "latest", boundary: null };
    throw new InvalidRecoveryDetailRequest();
  }
  if (window !== null || !BASE64URL.test(cursor)) throw new InvalidRecoveryDetailRequest();
  try {
    const buffer = Buffer.from(cursor, "base64url");
    if (buffer.toString("base64url") !== cursor || buffer.length > 768) throw new Error("noncanonical");
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    const data = value as Record<string, unknown>;
    if (Object.keys(data).sort().join(",") !== "at,direction,id,scope,v" ||
      data.v !== 1 || data.scope !== cursorScope(shopId, recoveryId, kind) ||
      (data.direction !== "previous" && data.direction !== "next") ||
      !validRecoveryId(data.id) || typeof data.at !== "string" ||
      !ISO_DATE.test(data.at)) throw new Error("content");
    const at = new Date(data.at);
    if (!Number.isFinite(at.getTime()) || at.toISOString() !== data.at) throw new Error("timestamp");
    return { direction: data.direction, boundary: { at, id: data.id } };
  } catch {
    throw new InvalidRecoveryDetailRequest();
  }
}
