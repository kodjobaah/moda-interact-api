import { createHash } from "node:crypto";

export type RecurringOperationKind = "SUBSCRIPTION_CREATE" | "PLAN_SWITCH" | "CANCEL";

export function validateIdempotencyKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function recurringRequestFingerprint(input: {
  kind: RecurringOperationKind;
  shopId: string;
  providerReference?: string;
  merchantPricingPlanId?: string;
  quotedAmountMinor?: number;
  quotedCurrency?: string;
  quotedBillingPeriod?: string;
}): Buffer {
  assertCanonicalField(input.shopId);
  const fields = ["arch027-recurring-v1", input.kind, input.shopId];
  if (input.kind !== "CANCEL") {
    if (
      !input.merchantPricingPlanId || !Number.isSafeInteger(input.quotedAmountMinor) ||
      !input.quotedCurrency || !input.quotedBillingPeriod
    ) throw new TypeError("recurring quote fields are required");
    assertCanonicalField(input.merchantPricingPlanId);
    assertCanonicalField(String(input.quotedAmountMinor));
    assertCanonicalField(input.quotedCurrency);
    assertCanonicalField(input.quotedBillingPeriod);
    fields.push(
      input.merchantPricingPlanId,
      String(input.quotedAmountMinor),
      input.quotedCurrency,
      input.quotedBillingPeriod,
    );
  }
  if (input.kind !== "SUBSCRIPTION_CREATE") {
    if (!input.providerReference) throw new TypeError("provider reference is required");
    assertCanonicalField(input.providerReference);
    fields.splice(3, 0, input.providerReference);
  }
  return createHash("sha256").update(`${fields.join("\n")}\n`, "utf8").digest();
}

function assertCanonicalField(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      throw new TypeError("recurring fingerprint fields must not contain control characters");
    }
  }
}

export function formatUsdMinorUnits(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new TypeError("amountMinor must be a non-negative safe integer");
  }
  const whole = Math.floor(amountMinor / 100);
  const cents = String(amountMinor % 100).padStart(2, "0");
  return `${whole}.${cents}`;
}

export function createWooReturnUrl(canonicalSiteUrl: string, operationId: string): string {
  const site = new URL(canonicalSiteUrl);
  if (site.protocol !== "https:") throw new TypeError("canonical Woo site must use HTTPS");
  site.search = "";
  site.hash = "";
  if (!site.pathname.endsWith("/")) site.pathname += "/";
  const returnUrl = new URL("wp-admin/admin.php", site);
  returnUrl.search = new URLSearchParams([
    ["page", "wc-admin"],
    ["path", "/moda-interact"],
    ["moda_billing_return", "1"],
    ["operation", operationId],
  ]).toString();
  return returnUrl.toString();
}