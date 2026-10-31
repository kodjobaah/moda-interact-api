import assert from "node:assert/strict";
import test from "node:test";
import { WooRestoreResolveResponseV1Schema } from "@modainteract/moda-interact-shared/woocommerce";
import { WooRecoveryRestoreService } from "../../../../src/woocommerce/recovery-restore/service.js";

const now = new Date("2026-10-30T12:00:00.000Z");
const principal = {
  installationId: "install_123",
  shopId: "shop_123",
  canonicalSiteUrl: "https://merchant.example/store",
  credentialVersion: 4,
};
const token = Buffer.alloc(32, 8).toString("base64url");
const recoveryId = "recovery_123";
const restoreUrl = `${principal.canonicalSiteUrl}/?moda_interact_resume=1&r=${recoveryId}&t=${token}`;
const snapshot = {
  schemaVersion: "woo.cart-restore.v1",
  kind: "supported",
  appliedCouponCodes: ["EXPIRED10"],
  lines: [{ productId: "101", quantity: 2 }],
};

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    checkoutRecoveryLifetimeDays: 21,
    id: recoveryId,
    shopId: principal.shopId,
    checkoutToken: "checkout_key_123",
    generation: 2,
    status: "MESSAGE_SENT",
    completedAt: null,
    expiredAt: null,
    lastExternalActivityAt: new Date(now.getTime() - 60_000),
    checkoutUrl: restoreUrl,
    wooRestoreSnapshot: snapshot,
    shopDomain: principal.canonicalSiteUrl,
    shopStatus: "ACTIVE",
    shopPlatform: "WOOCOMMERCE",
    shopifyShopId: null,
    installationCanonicalSiteUrl: principal.canonicalSiteUrl,
    installationStatus: "ACTIVE",
    installationCredentialVersion: principal.credentialVersion,
    installationRevokedAt: null,
    ...overrides,
  };
}

function harness(rows: unknown[] | (() => unknown[])) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const service = new WooRecoveryRestoreService({
    async $queryRaw(query: { sql: string; values: unknown[] }) {
      queries.push(query);
      return typeof rows === "function" ? rows() : rows;
    },
  } as never, () => now);
  return { service, queries };
}

test("resolves only the tenant's latest supported eligible recovery and returns the complete Shared v1 response", async () => {
  const { service, queries } = harness([makeRow()]);
  const result = await service.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
  });

  assert.ok(result);
  assert.deepEqual(WooRestoreResolveResponseV1Schema.parse(result), {
    schemaVersion: "woo.restore.resolve.v1",
    status: "eligible",
    recoveryId,
    checkoutKey: "checkout_key_123",
    snapshot,
    outreachOffer: { kind: "NONE", reason: "NO_CONFIRMED_OFFER" },
  });
  assert.match(queries[0]!.sql, /LEFT JOIN "public"\."BackgroundRuntimeConfig"/);
  assert.match(queries[0]!.sql, /config\."id" = 'default'/);
  assert.match(queries[0]!.sql, /cr\."shopId" =/);
  assert.match(queries[0]!.sql, /MAX\(latest\."generation"\)/);
  assert.ok(queries[0]!.values.includes(principal.shopId));
  assert.ok(queries[0]!.values.includes(principal.installationId));
  assert.equal("$executeRaw" in service, false);
});

test("uniformly denies wrong tenant, terminal, stale, disabled and unsupported recovery state", async () => {
  const cases = [
    makeRow({ shopId: "another-shop" }),
    makeRow({ status: "COMPLETED", completedAt: now }),
    makeRow({ status: "CANCELLED" }),
    makeRow({ status: "EXPIRED", expiredAt: now }),
    makeRow({ status: "PENDING" }),
    makeRow({ lastExternalActivityAt: new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000) }),
    makeRow({ lastExternalActivityAt: new Date(now.getTime() + 1) }),
    makeRow({ shopStatus: "UNINSTALLED" }),
    makeRow({ shopPlatform: "SHOPIFY", shopifyShopId: "legacy" }),
    makeRow({ installationStatus: "REVOKED" }),
    makeRow({ installationRevokedAt: now }),
    makeRow({ installationCredentialVersion: 3 }),
    makeRow({ shopDomain: "https://other.example/store" }),
    makeRow({ installationCanonicalSiteUrl: "https://other.example/store" }),
    makeRow({ wooRestoreSnapshot: { schemaVersion: "woo.cart-restore.v1", kind: "unsupported",
      reason: "ITEMS_UNAVAILABLE", appliedCouponCodes: [] } }),
    makeRow({ wooRestoreSnapshot: { ...snapshot, extra: true } }),
  ];
  for (const row of cases) {
    const { service } = harness([row]);
    assert.equal(await service.resolve(principal, {
      schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
    }), null);
  }
});

test("uses the canonical lifetime with exact millisecond boundaries and no business maximum", async () => {
  const dayMs = 86_400_000;
  for (const days of [1, 21, 91, 180, 365]) {
    for (const [ageMs, expected] of [
      [days * dayMs - 1, true],
      [days * dayMs, false],
      [days * dayMs + 1, false],
    ] as const) {
      const { service } = harness([makeRow({
        checkoutRecoveryLifetimeDays: days,
        lastExternalActivityAt: new Date(now.getTime() - ageMs),
      })]);
      const result = await service.resolve(principal, {
        schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
      });
      assert.equal(Boolean(result), expected);
    }
  }

  const eightDaysOld = new Date(now.getTime() - 8 * dayMs);
  for (const lifetimeDays of [21, 91, 180, 365, 2_147_483_647]) {
    const { service } = harness([makeRow({
      checkoutRecoveryLifetimeDays: lifetimeDays,
      lastExternalActivityAt: lifetimeDays === 2_147_483_647
        ? new Date(now.getTime() - 90_000_000 * dayMs)
        : eightDaysOld,
    })]);
    assert.ok(await service.resolve(principal, {
      schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
    }));
  }

  const sixMinutesOld = harness([makeRow({ lastExternalActivityAt: new Date(now.getTime() - 6 * 60_000) })]);
  assert.ok(await sixMinutesOld.service.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
  }));
});

test("zero lifetime always denies and invalid or missing configuration fails closed", async () => {
  for (const lastExternalActivityAt of [now, new Date(now.getTime() - 1)]) {
    const { service } = harness([makeRow({ checkoutRecoveryLifetimeDays: 0, lastExternalActivityAt })]);
    assert.equal(await service.resolve(principal, {
      schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
    }), null);
  }

  for (const checkoutRecoveryLifetimeDays of [null, -1, 1.5, "21", 2_147_483_648, undefined]) {
    const { service } = harness([makeRow({ checkoutRecoveryLifetimeDays })]);
    await assert.rejects(service.resolve(principal, {
      schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
    }), /Invalid checkout recovery lifetime configuration/);
  }

  const { service } = harness([makeRow({ id: null, checkoutRecoveryLifetimeDays: null })]);
  await assert.rejects(service.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
  }), /Invalid checkout recovery lifetime configuration/);
});

test("reads changed policy on the next resolve and propagates database failures", async () => {
  const row = makeRow({ lastExternalActivityAt: new Date(now.getTime() - 8 * 86_400_000) });
  const { service, queries } = harness(() => [row]);
  assert.ok(await service.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
  }));
  row.checkoutRecoveryLifetimeDays = 1;
  assert.equal(await service.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
  }), null);
  assert.equal(queries.length, 2);

  const dependencyError = new Error("database unavailable");
  const broken = new WooRecoveryRestoreService({
    async $queryRaw() { throw dependencyError; },
  } as never, () => now);
  await assert.rejects(broken.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId, token,
  }), error => error === dependencyError);
});

test("rejects token, recovery identity, host, scheme, query and path tampering", async () => {
  const cases: Array<{ row?: Record<string, unknown>; token?: string }> = [
    { token: Buffer.alloc(32, 9).toString("base64url") },
    { row: { checkoutUrl: `${principal.canonicalSiteUrl}/?moda_interact_resume=1&r=another&t=${token}` } },
    { row: { checkoutUrl: `https://attacker.example/store/?moda_interact_resume=1&r=${recoveryId}&t=${token}` } },
    { row: { checkoutUrl: `http://merchant.example/store/?moda_interact_resume=1&r=${recoveryId}&t=${token}` } },
    { row: { checkoutUrl: `${principal.canonicalSiteUrl}/wrong/?moda_interact_resume=1&r=${recoveryId}&t=${token}` } },
    { row: { checkoutUrl: `${restoreUrl}&shopId=shop_123` } },
    { row: { checkoutUrl: `${principal.canonicalSiteUrl}/?moda_interact_resume=1&r=${recoveryId}&r=${recoveryId}&t=${token}` } },
    { row: { checkoutUrl: `${restoreUrl}#fragment` } },
  ];
  for (const current of cases) {
    const { service } = harness([makeRow(current.row)]);
    assert.equal(await service.resolve(principal, {
      schemaVersion: "woo.restore.resolve.v1", recoveryId, token: current.token ?? token,
    }), null);
  }
});