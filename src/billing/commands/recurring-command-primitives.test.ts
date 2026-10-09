import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createWooReturnUrl,
  formatUsdMinorUnits,
  recurringRequestFingerprint,
  validateIdempotencyKey,
} from "./recurring-command-primitives.js";

test("Idempotency-Key accepts bounded ASCII keys after trimming", () => {
  for (const valid of ["a", "A-1._:key", "x".repeat(128)]) assert.equal(validateIdempotencyKey(valid), valid);
  assert.equal(validateIdempotencyKey("  trimmed-key  "), "trimmed-key");
  for (const invalid of [undefined, "", " ", "x".repeat(129), "bad/key", "é"]) {
    assert.equal(validateIdempotencyKey(invalid), null);
  }
});

test("recurring fingerprints use the exact versioned field order and raw SHA-256 bytes", () => {
  const vectors = [
    {
      input: {
        kind: "SUBSCRIPTION_CREATE" as const,
        shopId: "shop_1",
        merchantPricingPlanId: "mp_growth",
        quotedAmountMinor: 4900,
        quotedCurrency: "USD",
        quotedBillingPeriod: "EVERY_30_DAYS",
      },
      intent: "arch027-recurring-v1\nSUBSCRIPTION_CREATE\nshop_1\nmp_growth\n4900\nUSD\nEVERY_30_DAYS\n",
    },
    {
      input: {
        kind: "PLAN_SWITCH" as const,
        shopId: "shop_1",
        providerReference: "woo-contract",
        merchantPricingPlanId: "mp_growth",
        quotedAmountMinor: 4900,
        quotedCurrency: "USD",
        quotedBillingPeriod: "EVERY_30_DAYS",
      },
      intent: "arch027-recurring-v1\nPLAN_SWITCH\nshop_1\nwoo-contract\nmp_growth\n4900\nUSD\nEVERY_30_DAYS\n",
    },
    {
      input: { kind: "CANCEL" as const, shopId: "shop_1", providerReference: "woo-contract" },
      intent: "arch027-recurring-v1\nCANCEL\nshop_1\nwoo-contract\n",
    },
  ];
  for (const { input, intent } of vectors) {
    const actual = recurringRequestFingerprint(input);
    assert.equal(actual.length, 32);
    assert.deepEqual(actual, createHash("sha256").update(intent, "utf8").digest());
  }
  assert.throws(() => recurringRequestFingerprint({
    kind: "CANCEL", shopId: "shop\nforged", providerReference: "contract",
  }), TypeError);
});

test("USD minor-unit formatting preserves exact cents through large safe integers", () => {
  assert.equal(formatUsdMinorUnits(2000), "20.00");
  assert.equal(formatUsdMinorUnits(2001), "20.01");
  assert.equal(formatUsdMinorUnits(1999), "19.99");
  assert.equal(formatUsdMinorUnits(Number.MAX_SAFE_INTEGER), "90071992547409.91");
  assert.throws(() => formatUsdMinorUnits(-1), TypeError);
  assert.throws(() => formatUsdMinorUnits(Number.MAX_SAFE_INTEGER + 1), TypeError);
});

test("Woo return URL preserves a WordPress sub-path and ignores caller URL state", () => {
  const actual = new URL(createWooReturnUrl("https://merchant.example/subsite/?redirect=evil#frag", "op /?"));
  assert.equal(actual.origin, "https://merchant.example");
  assert.equal(actual.pathname, "/subsite/wp-admin/admin.php");
  assert.deepEqual([...actual.searchParams.entries()], [
    ["page", "wc-admin"],
    ["path", "/moda-interact"],
    ["moda_billing_return", "1"],
    ["operation", "op /?"],
  ]);
  assert.throws(() => createWooReturnUrl("http://merchant.example", "operation"), TypeError);
});