import assert from "node:assert/strict";
import test from "node:test";
import { MerchantRecoveryPolicyService } from "../../../../src/merchant/recovery-policy/service.js";
import { RecoveryPolicyConflictError, RecoveryPolicyIntegrityError, type RecoveryPolicyUpdate } from "../../../../src/merchant/recovery-policy/contract.js";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";

const now = new Date("2026-10-12T10:00:00.000Z");
const principal: WooInstallationPrincipal = {
  shopId: "shop_woo", installationId: "woo_1", canonicalSiteUrl: "https://woo.example", credentialVersion: 2,
};
const defaultPolicy: Policy = { recoveryDelayMinutes: 30, recoveryOfferMode: "NONE", fixedShopifyDiscountId: null,
  followUpEnabled: false, followUpDelayMinutes: null, notifyOnInitialRecoveryOutreach: false };
const savedAt = new Date("2026-10-11T10:00:00.000Z");
const update: RecoveryPolicyUpdate = { expectedRevision: savedAt.toISOString(), recoveryDelayMinutes: 45,
  followUpEnabled: true, followUpDelayMinutes: 50, notifyOnInitialRecoveryOutreach: true };

type Policy = {
  recoveryDelayMinutes: number;
  recoveryOfferMode: "NONE" | "FIXED" | "AI_BEST_APPLICABLE";
  fixedShopifyDiscountId: string | null;
  followUpEnabled: boolean;
  followUpDelayMinutes: number | null;
  notifyOnInitialRecoveryOutreach: boolean;
};
type Stored = Policy & { updatedAt: Date; createdAt: Date; onboardingCompleted: boolean; shopId: string; id: string };
type Override = Policy & { expiresAt: Date | null };

function fixture(options: { settings?: Stored | null; override?: Override | null; shopPlatform?: string;
  installationVersion?: number; revoked?: boolean; active?: boolean; now?: Date } = {}) {
  const calls: string[] = [];
  let current: Stored | null = options.settings === undefined ? {
    ...defaultPolicy, id: "settings_1", shopId: principal.shopId, onboardingCompleted: true,
    updatedAt: savedAt, createdAt: savedAt,
  } : options.settings;
  const shop = { id: principal.shopId, domain: principal.canonicalSiteUrl, platform: options.shopPlatform ?? "WOOCOMMERCE",
    status: options.active === false ? "UNINSTALLED" : "ACTIVE", shopifyShopId: null, onboardingCompleted: true };
  const installation = { id: principal.installationId, shopId: principal.shopId,
    canonicalSiteUrl: principal.canonicalSiteUrl, credentialVersion: options.installationVersion ?? 2,
    status: "ACTIVE", revokedAt: options.revoked ? now : null };
  let gate = Promise.resolve();
  const db = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const previous = gate;
      let release = () => {};
      gate = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback({
          $queryRaw: async (query: { strings: readonly string[] }) => {
            const sql = query.strings.join("");
            if (sql.includes('"commerce"."Shop"')) {
              calls.push(sql.includes("FOR UPDATE") ? "shop-lock" : "shop-read");
              return [shop];
            }
            if (sql.includes('"woocommerce"."WooCommerceInstallation"')) {
              calls.push(sql.includes("FOR SHARE") ? "installation-lock" : "installation-read");
              return [installation];
            }
            throw new Error("unexpected SQL");
          },
          shopSettings: {
            findUnique: async () => current,
            update: async ({ data }: { data: Partial<Stored> }) => {
              calls.push("settings-update"); current = { ...current!, ...data }; return current;
            },
            create: async ({ data }: { data: Partial<Stored> }) => {
              calls.push("settings-create");
              current = { ...defaultPolicy, ...data, id: "settings_new", shopId: principal.shopId,
                onboardingCompleted: true, updatedAt: data.updatedAt ?? now, createdAt: now };
              return current;
            },
          },
          shopRecoveryPolicyOverride: {
            findUnique: async () => options.override ?? null,
            // No write methods exposed in this fixture: any attempted override mutation fails.
          },
        });
      } finally { release(); }
    },
  };
  return { service: new MerchantRecoveryPolicyService(db as never, () => options.now ?? now),
    calls, current: () => current };
}

test("missing settings GET uses the Background defaults without creating rows", async () => {
  const state = fixture({ settings: null });
  const result = await state.service.read(principal);
  assert.equal(result.revision, "UNCONFIGURED");
  assert.deepEqual(result.merchant, { recoveryDelayMinutes: 30, recoveryOfferMode: "NONE", followUpEnabled: false, followUpDelayMinutes: null });
  assert.deepEqual(result.merchant, result.effective);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.notifyOnInitialRecoveryOutreach, false);
  assert.equal(result.offerSelectionAvailable, false);
  assert.equal(state.current(), null);
  assert.equal(state.calls.includes("settings-create"), false);
});

test("first update creates only merchant settings with NONE and no Shopify discount", async () => {
  const state = fixture({ settings: null });
  const result = await state.service.update(principal, { ...update, expectedRevision: "UNCONFIGURED" });
  assert.equal(result.merchant.recoveryDelayMinutes, 45);
  assert.equal(result.merchant.followUpDelayMinutes, 50);
  assert.equal(result.notifyOnInitialRecoveryOutreach, true);
  assert.equal(result.revision, now.toISOString());
  assert.equal(state.current()?.recoveryOfferMode, "NONE");
  assert.equal(state.current()?.fixedShopifyDiscountId, null);
  assert.equal(state.current()?.notifyOnInitialRecoveryOutreach, true);
  assert.deepEqual(state.calls.filter((call) => call.startsWith("settings-")), ["settings-create"]);
  assert.ok(state.calls.indexOf("shop-lock") < state.calls.indexOf("settings-create"));
});

test("merchant revision advances, reads reflect saved policy, and identical replay is read-only", async () => {
  const state = fixture();
  const first = await state.service.update(principal, update);
  const replay = await state.service.update(principal, update);
  const after = await state.service.read(principal);
  assert.equal(first.revision, now.toISOString());
  assert.deepEqual(replay, first);
  assert.deepEqual(after, first);
  assert.equal(state.calls.filter((call) => call === "settings-update").length, 1);
});

test("notification-only saves advance revision, persist ON/OFF, and replay as a no-op", async () => {
  const state = fixture();
  const on = await state.service.update(principal, {
    expectedRevision: savedAt.toISOString(), recoveryDelayMinutes: 30, followUpEnabled: false,
    followUpDelayMinutes: null, notifyOnInitialRecoveryOutreach: true,
  });
  assert.equal(on.notifyOnInitialRecoveryOutreach, true);
  assert.equal(on.revision, now.toISOString());
  assert.equal(state.current()?.notifyOnInitialRecoveryOutreach, true);

  const onReplay = await state.service.update(principal, {
    expectedRevision: savedAt.toISOString(), recoveryDelayMinutes: 30, followUpEnabled: false,
    followUpDelayMinutes: null, notifyOnInitialRecoveryOutreach: true,
  });
  assert.deepEqual(onReplay, on);
  assert.equal(state.calls.filter((call) => call === "settings-update").length, 1);

  const off = await state.service.update(principal, {
    expectedRevision: on.revision, recoveryDelayMinutes: 30, followUpEnabled: false,
    followUpDelayMinutes: null, notifyOnInitialRecoveryOutreach: false,
  });
  assert.equal(off.notifyOnInitialRecoveryOutreach, false);
  assert.equal(off.revision, "2026-10-12T10:00:00.001Z");
  assert.equal(state.current()?.notifyOnInitialRecoveryOutreach, false);
  assert.equal(state.calls.filter((call) => call === "settings-update").length, 2);
});

test("concurrent stale updates cannot lose a write and monotonic revisions survive rapid edits", async () => {
  const state = fixture();
  const [a, b] = await Promise.allSettled([
    state.service.update(principal, { ...update, recoveryDelayMinutes: 45 }),
    state.service.update(principal, { ...update, recoveryDelayMinutes: 65 }),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  if (b.status === "rejected") assert.equal((b.reason as RecoveryPolicyConflictError).code, "recovery_policy_conflict");
  assert.equal(state.calls.filter((call) => call === "settings-update").length, 1);
  const second = await state.service.update(principal, { ...update,
    expectedRevision: state.current()!.updatedAt.toISOString(), recoveryDelayMinutes: 65 });
  assert.equal(second.revision, "2026-10-12T10:00:00.001Z");
});

test("active and expired platform-admin overrides only change effective values", async () => {
  const override: Override = { ...defaultPolicy, recoveryDelayMinutes: 90, followUpEnabled: true,
    followUpDelayMinutes: 120, expiresAt: new Date("2026-10-13T00:00:00.000Z") };
  const active = fixture({ override });
  const result = await active.service.update(principal, update);
  assert.equal(result.merchant.recoveryDelayMinutes, 45);
  assert.equal(result.effective.recoveryDelayMinutes, 90);
  assert.equal(result.source, "ADMIN_OVERRIDE");
  assert.equal(result.overrideActive, true);
  assert.equal(result.notifyOnInitialRecoveryOutreach, true);
  const expired = fixture({ override: { ...override, expiresAt: now } });
  const after = await expired.service.read(principal);
  assert.equal(after.source, "MERCHANT");
  assert.equal(after.effective.recoveryDelayMinutes, 30);
  assert.equal(after.notifyOnInitialRecoveryOutreach, false);
});

test("GET does not conceal historical provider-specific mode; PUT fails closed", async () => {
  const state = fixture({ settings: { ...defaultPolicy, recoveryOfferMode: "FIXED", fixedShopifyDiscountId: "shopify_1",
    id: "s", shopId: principal.shopId, onboardingCompleted: true, createdAt: savedAt, updatedAt: savedAt } });
  const result = await state.service.read(principal);
  assert.equal(result.merchant.recoveryOfferMode, "FIXED");
  assert.equal(result.offerSelectionAvailable, false);
  assert.equal(JSON.stringify(result).includes("shopify_1"), false);
  await assert.rejects(() => state.service.update(principal, update), (error: unknown) =>
    error instanceof RecoveryPolicyConflictError && error.code === "recovery_offer_unsupported");
  assert.equal(state.calls.includes("settings-update"), false);
});

test("wrong provider, revoked credentials, stale installation and inactive Shop deny all operations", async () => {
  for (const options of [{ shopPlatform: "SHOPIFY" }, { revoked: true }, { installationVersion: 1 }, { active: false }]) {
    const state = fixture(options);
    await assert.rejects(() => state.service.read(principal), RecoveryPolicyIntegrityError);
    await assert.rejects(() => state.service.update(principal, update), RecoveryPolicyIntegrityError);
    assert.equal(state.calls.some((call) => call.startsWith("settings-")), false);
  }
});

test("no-op UNCONFIGURED replay avoids manufacturing a row", async () => {
  const state = fixture({ settings: null });
  const result = await state.service.update(principal, { ...update, expectedRevision: "UNCONFIGURED",
    recoveryDelayMinutes: 30, followUpEnabled: false, followUpDelayMinutes: null,
    notifyOnInitialRecoveryOutreach: false });
  assert.equal(result.revision, "UNCONFIGURED");
  assert.equal(state.current(), null);
});
