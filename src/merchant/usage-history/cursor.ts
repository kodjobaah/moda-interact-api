import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { UsageHistoryRequestError, type UsageView, validUsagePeriodId } from "./contract.js";

export interface PeriodBoundary {
  direction: "next" | "previous";
  start: Date;
  id: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The installed site's existing random bearer-credential digest is a private,
 * rotation-bound HMAC key; no extra shared global cursor secret is necessary.
 * Cursor signatures are never exposed outside the authenticated shop response.
 */
function scope(shopId: string, view: UsageView): string {
  return createHash("sha256").update("woo-usage-history-scope-v1\0").update(shopId).update("\0").update(view).digest("hex");
}

function signature(key: Uint8Array, data: string): Buffer {
  return createHmac("sha256", key).update("woo-usage-history-period-v1\0").update(data).digest();
}

export function encodePeriodCursor(
  shopId: string, view: UsageView, boundary: PeriodBoundary, key: Uint8Array,
): string {
  const payload = JSON.stringify({
    v: 1, scope: scope(shopId, view), direction: boundary.direction,
    start: boundary.start.toISOString(), id: boundary.id,
  });
  return Buffer.from(JSON.stringify({
    payload: Buffer.from(payload).toString("base64url"),
    signature: signature(key, payload).toString("base64url"),
  })).toString("base64url");
}

export function decodePeriodCursor(
  token: string | null, shopId: string, view: UsageView, key: Uint8Array,
): PeriodBoundary | null {
  if (token === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(token)) throw new Error();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length > 768 || bytes.toString("base64url") !== token) throw new Error();
    const envelope: unknown = JSON.parse(bytes.toString("utf8"));
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error();
    const outer = envelope as Record<string, unknown>;
    if (Object.keys(outer).sort().join(",") !== "payload,signature" ||
        typeof outer.payload !== "string" || typeof outer.signature !== "string") throw new Error();
    const payload = Buffer.from(outer.payload, "base64url");
    if (payload.toString("base64url") !== outer.payload || payload.length > 512) throw new Error();
    const supplied = Buffer.from(outer.signature, "base64url");
    const expected = signature(key, payload.toString("utf8"));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const object: unknown = JSON.parse(payload.toString("utf8"));
    if (!object || typeof object !== "object" || Array.isArray(object)) throw new Error();
    const row = object as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "direction,id,scope,start,v" ||
        row.v !== 1 || row.scope !== scope(shopId, view) ||
        (row.direction !== "next" && row.direction !== "previous") ||
        !validUsagePeriodId(row.id) || typeof row.start !== "string" || !ISO_DATE.test(row.start)) throw new Error();
    const start = new Date(row.start);
    if (!Number.isFinite(start.getTime()) || start.toISOString() !== row.start) throw new Error();
    return { direction: row.direction, start, id: row.id };
  } catch {
    throw new UsageHistoryRequestError("invalid_cursor");
  }
}
