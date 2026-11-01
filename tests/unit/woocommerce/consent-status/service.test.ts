import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { WooConsentStatusService } from "../../../../src/woocommerce/consent-status/service.js";
import { WOO_CONSENT_STATUS_VERSION, type WooConsentStatusProbe } from "../../../../src/woocommerce/consent-status/contract.js";

const principal = { shopId: "shop", installationId: "install", canonicalSiteUrl: "https://woo.test", credentialVersion: 1 };
const proof: WooConsentStatusProbe = { schemaVersion: WOO_CONSENT_STATUS_VERSION,
  canonicalPhone: "447400123456", grantEventId: "woo-grant-1" };

test("one indexed proof/current-state query; never a read transaction or feature lookup", async () => {
  let calls = 0;
  const sqlQueries: string[] = [];
  const db = {
    async $queryRaw(sql: { strings: readonly string[] }) {
      calls++;
      sqlQueries.push(sql.strings.join(" ? "));
      return [{ matched: 1 }];
    },
    $transaction() { throw new Error("Read transaction must not be used"); },
  } as unknown as Pick<PrismaClient, "$queryRaw">;
  const service = new WooConsentStatusService(db);
  assert.deepEqual(await service.read(principal, proof), {
    schemaVersion: WOO_CONSENT_STATUS_VERSION, state: "CONFIRMED_GRANTED",
  });
  assert.equal(calls, 1);
  assert.match(sqlQueries[0]!, /WhatsAppConsentEvidence/);
  for (const entity of ["CustomerPhone", "Customer", "WooCommerceInstallation", "Shop"]) {
    assert.match(sqlQueries[0]!, new RegExp(entity));
  }
  for (const clause of ["whatsappConsentRevision", "whatsappConsentDecisionSequence",
    "credentialVersion", "installationId", "purpose", "endedAt"]) {
    assert.match(sqlQueries[0]!, new RegExp(clause));
  }
  assert.doesNotMatch(sqlQueries[0]!, /Subscription|FeaturePreference|Billing|FOR UPDATE|FOR SHARE/);
});

test("a missing joined proof is UNVERIFIED without a fallback phone-only lookup", async () => {
  let calls = 0;
  const db = { async $queryRaw() { calls++; return []; } } as unknown as Pick<PrismaClient, "$queryRaw">;
  const result = await new WooConsentStatusService(db).read(principal, proof);
  assert.equal(result.state, "UNVERIFIED");
  assert.equal(calls, 1);
});

test("unexpected DB exceptions propagate to the route; never become UNVERIFIED silently", async () => {
  const original = Object.assign(new Error("original provider error"), { code: "P2028" });
  const db = { async $queryRaw() { throw original; } } as unknown as Pick<PrismaClient, "$queryRaw">;
  await assert.rejects(new WooConsentStatusService(db).read(principal, proof), error => error === original);
});
