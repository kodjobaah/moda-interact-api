import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { WooRecoveryRestoreService } from "../../../../src/woocommerce/recovery-restore/service.js";

const databaseUrl = process.env.ARCH053_WOO_RESTORE_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("ARCH053_WOO_RESTORE_TEST_DATABASE_URL is required");

const database = (url: string) => new PrismaClient({ datasources: { db: { url } } });
const reader = database(databaseUrl);
const mutator = database(databaseUrl);
const shopId = `arch055_restore_shop_${randomUUID()}`;
const installationId = `arch055_restore_installation_${randomUUID()}`;
const canonicalSiteUrl = `https://arch055-${randomUUID()}.example/store`;
const token = Buffer.alloc(32, 0x53).toString("base64url");
const snapshot = { schemaVersion: "woo.cart-restore.v1", kind: "supported", appliedCouponCodes: [], lines: [] };
const principal = { shopId, installationId, canonicalSiteUrl, credentialVersion: 1 };
const noOffer = { kind: "NONE", reason: "NO_CONFIRMED_OFFER" } as const;

after(async () => {
  await Promise.all([reader.$disconnect(), mutator.$disconnect()]);
});

async function insertRecovery(id: string, checkoutToken: string, generation = 1): Promise<void> {
  await reader.$executeRaw`
    INSERT INTO "commerce"."CheckoutRecovery"
      ("id", "shopId", "checkoutToken", "generation", "status", "lastExternalActivityAt",
       "checkoutUrl", "wooRestoreSnapshot")
    VALUES (${id}, ${shopId}, ${checkoutToken}, ${generation}, 'DETECTED', CURRENT_TIMESTAMP,
      ${`${canonicalSiteUrl}/?moda_interact_resume=1&r=${id}&t=${token}`}, ${JSON.stringify(snapshot)}::jsonb)
  `;
}

test("restore revalidates completion, generation, and lifetime after offer resolution", async () => {
  await reader.$executeRaw`
    INSERT INTO "commerce"."Shop" ("id", "domain", "platform", "status", "shopifyShopId")
    VALUES (${shopId}, ${canonicalSiteUrl}, 'WOOCOMMERCE', 'ACTIVE', NULL)
  `;
  await reader.$executeRaw`
    INSERT INTO "woocommerce"."WooCommerceInstallation"
      ("id", "shopId", "canonicalSiteUrl", "credentialDigest", "credentialVersion")
    VALUES (${installationId}, ${shopId}, ${canonicalSiteUrl}, ${Buffer.alloc(32)}, 1)
  `;
  await reader.$executeRaw`
    INSERT INTO "public"."BackgroundRuntimeConfig" ("id", "checkoutRecoveryLifetimeDays")
    VALUES ('default', 21)
    ON CONFLICT ("id") DO UPDATE SET "checkoutRecoveryLifetimeDays" = 21
  `;

  const scenarios = [
    {
      name: "completion",
      recoveryId: `arch055_complete_${randomUUID()}`,
      checkoutToken: `checkout_complete_${randomUUID()}`,
      mutate: async (recoveryId: string) => {
        await mutator.$executeRaw`
          UPDATE "commerce"."CheckoutRecovery" SET "status" = 'COMPLETED', "completedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${recoveryId}
        `;
      },
    },
    {
      name: "generation",
      recoveryId: `arch055_generation_${randomUUID()}`,
      checkoutToken: `checkout_generation_${randomUUID()}`,
      mutate: async (recoveryId: string, checkoutToken: string) => {
        await mutator.$executeRaw`
          INSERT INTO "commerce"."CheckoutRecovery"
            ("id", "shopId", "checkoutToken", "generation", "status", "lastExternalActivityAt",
             "checkoutUrl", "wooRestoreSnapshot")
          VALUES (${`newer_${recoveryId}`}, ${shopId}, ${checkoutToken}, 2, 'DETECTED', CURRENT_TIMESTAMP,
            ${`${canonicalSiteUrl}/?moda_interact_resume=1&r=newer_${recoveryId}&t=${token}`},
            ${JSON.stringify(snapshot)}::jsonb)
        `;
      },
    },
    {
      name: "lifetime",
      recoveryId: `arch055_lifetime_${randomUUID()}`,
      checkoutToken: `checkout_lifetime_${randomUUID()}`,
      mutate: async () => {
        await mutator.$executeRaw`
          UPDATE "public"."BackgroundRuntimeConfig" SET "checkoutRecoveryLifetimeDays" = 0 WHERE "id" = 'default'
        `;
      },
    },
  ];

  for (const scenario of scenarios) {
    await insertRecovery(scenario.recoveryId, scenario.checkoutToken);
    let offerResolutionReached = false;
    const service = new WooRecoveryRestoreService(reader, {
      async read() {
        offerResolutionReached = true;
        await scenario.mutate(scenario.recoveryId, scenario.checkoutToken);
        return noOffer;
      },
    });
    const result = await service.resolve(principal, {
      schemaVersion: "woo.restore.resolve.v1", recoveryId: scenario.recoveryId, token,
    });
    assert.equal(offerResolutionReached, true, `${scenario.name}: first eligibility read must succeed`);
    assert.equal(result, null, `${scenario.name}: second eligibility read must reject stale evidence`);
  }
});