import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";

export type RecoverySourceIdentity =
  | { kind: "recovery"; id: string }
  | { kind: "outreach"; id: string };

export type ReservationSourceEvidence = {
  shopId: string;
  sourceKey: string;
  billingPeriodEntitlementCounterId: string | null;
  billingPeriodEntitlementCounter: {
    shopId: string;
    billingPeriodId: string;
    counter: string;
  } | null;
};

const IDENTIFIER = /^[A-Za-z0-9_-]{1,191}$/;

/**
 * Resolve a candidate only from the canonical Shared billing key. Its result is
 * a locator, not proof of ownership: callers must fetch and verify the actual
 * same-Shop recovery or outreach attempt before exposing a merchant link.
 *
 * The Shared codec deliberately hashes oversized identifiers. A hashed key is
 * not reversible and must remain unlinked until explicit durable evidence is
 * available. Do not guess from customer identity or checkout timestamps.
 */
export function recoverySourceFromReservationKey(
  reservation: ReservationSourceEvidence,
  shopId: string,
): RecoverySourceIdentity | null {
  if (reservation.shopId !== shopId || typeof reservation.sourceKey !== "string") return null;
  let logicalSource = reservation.sourceKey;
  if (reservation.billingPeriodEntitlementCounterId !== null) {
    const periodCounter = reservation.billingPeriodEntitlementCounter;
    if (periodCounter?.shopId !== shopId || periodCounter.counter !== "INCLUDED_RECOVERY_CREDITS") {
      return null;
    }
    const prefix = `paid-included:${periodCounter.billingPeriodId}:`;
    if (!logicalSource.startsWith(prefix)) return null;
    logicalSource = logicalSource.slice(prefix.length);
  } else if (logicalSource.startsWith("paid-included:")) {
    return null;
  }

  const prefix = `recovery:${shopId}:`;
  if (!logicalSource.startsWith(prefix)) return null;
  const suffix = logicalSource.slice(prefix.length);
  const outreachPrefix = "recovery-outreach:";
  if (suffix.startsWith(outreachPrefix)) {
    const id = suffix.slice(outreachPrefix.length);
    if (!IDENTIFIER.test(id) || logicalSource !== createRecoveryIdempotencyKey(shopId, suffix)) return null;
    return { kind: "outreach", id };
  }
  // Shared uses `recovery:h<16 hex>` for oversized keys. Such a key is not
  // reversible; even a coincidentally matching recovery ID must fail closed.
  if (/^h[0-9a-f]{16}$/i.test(suffix)) return null;
  if (!IDENTIFIER.test(suffix) || logicalSource !== createRecoveryIdempotencyKey(shopId, suffix)) return null;
  return { kind: "recovery", id: suffix };
}
