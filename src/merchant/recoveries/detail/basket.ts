import type { RecoveryBasket, RecoveryMoney } from "./contracts.js";

const MAX_ITEMS = 50;
const MAX_SNAPSHOT_BYTES = 128_000;
const AMOUNT = /^\d{1,30}(?:\.\d{1,30})?$/;
const CURRENCY = /^[A-Z]{3}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function description(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function money(amount: unknown, currency: string | null): RecoveryMoney | null {
  if (typeof amount !== "string" || !AMOUNT.test(amount) ||
    !currency || !CURRENCY.test(currency)) return null;
  return { amount, currency };
}

/** Reads the saved CheckoutRecovery.lineItems v1 shape, not live Woo/Shopify cart state.
 * The writer stores `price` (unit price), not an image or discounted line total.
 */
export function recoveryBasket(snapshot: unknown, total: RecoveryMoney, currency: string | null): RecoveryBasket {
  const recoveryTotal = { amount: total.amount, currency: total.currency };
  if (snapshot === null) return { items: [], recoveryTotal, unavailableReason: "missing_snapshot" };
  if (!Array.isArray(snapshot)) return { items: [], recoveryTotal, unavailableReason: "invalid_snapshot" };
  // Never serialize or iterate an unbounded JSON snapshot.
  if (snapshot.length > 250) return { items: [], recoveryTotal, unavailableReason: "oversized_snapshot" };
  try {
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
      return { items: [], recoveryTotal, unavailableReason: "oversized_snapshot" };
    }
  } catch {
    return { items: [], recoveryTotal, unavailableReason: "invalid_snapshot" };
  }
  let malformed = false;
  const items: RecoveryBasket["items"] = [];
  for (const entry of snapshot) {
    if (!record(entry)) { malformed = true; continue; }
    const title = description(entry.title, 255);
    const variantTitle = description(entry.variantTitle, 255);
    const quantity = typeof entry.quantity === "number" && Number.isSafeInteger(entry.quantity) && entry.quantity > 0 &&
      entry.quantity <= 1_000_000 ? entry.quantity : null;
    if (entry.quantity !== null && quantity === null) malformed = true;
    if (!title && !variantTitle && quantity === null) { malformed = true; continue; }
    const unitPrice = money(entry.price, currency);
    if (entry.price !== null && entry.price !== undefined && !unitPrice) malformed = true;
    if (items.length === MAX_ITEMS) { malformed = true; break; }
    items.push({
      title, variantTitle, quantity, unitPrice,
      // Neither image nor discounted line total is present in the persisted v1 writer.
      lineTotal: null, imageUrl: null,
    });
  }
  return { items, recoveryTotal, unavailableReason: malformed ? "partial_snapshot" : null };
}
