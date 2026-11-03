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
const snapshot = { schemaVersion: "woo.cart-restore.v1", kind: "supported", appliedCouponCodes: [], lines: [{ productId: "101", quantity: 1 }] };
const principal = { shopId, installationId, canonicalSiteUrl, credentialVersion: 1 };
const noOffer = { kind: "NONE", reason: "NO_CONFIRMED_OFFER" } as const;

after(async () => {
  await Promise.all([reader.$disconnect(), mutator.$disconnect()]);
});

async function insertRecovery(id: string, checkoutToken: string, generation = 1): Promise<void> {
  const lastExternalActivityAt = new Date(Date.now() - 60_000);
  await reader.$executeRaw`
    INSERT INTO "commerce"."CheckoutRecovery"
      ("id", "shopId", "checkoutToken", "generation", "status", "lastExternalActivityAt",
       "checkoutUrl", "wooRestoreSnapshot", "updatedAt")
    VALUES (${id}, ${shopId}, ${checkoutToken}, ${generation}, 'DETECTED', ${lastExternalActivityAt},
      ${`${canonicalSiteUrl}/?moda_interact_resume=1&r=${id}&t=${token}`}, ${JSON.stringify(snapshot)}::jsonb, CURRENT_TIMESTAMP)
  `;
}

test("restore revalidates completion, generation, lifetime, and credential rotation after offer resolution", async () => {
  await reader.$executeRaw`
    INSERT INTO "commerce"."Shop" ("id", "domain", "platform", "status", "shopifyShopId", "updatedAt")
    VALUES (${shopId}, ${canonicalSiteUrl}, 'WOOCOMMERCE', 'ACTIVE', NULL, CURRENT_TIMESTAMP)
  `;
  await reader.$executeRaw`
    INSERT INTO "woocommerce"."WooCommerceInstallation"
      ("id", "shopId", "canonicalSiteUrl", "credentialDigest", "credentialVersion")
    VALUES (${installationId}, ${shopId}, ${canonicalSiteUrl}, ${Buffer.alloc(32)}, 1)
  `;
  await reader.$executeRaw`
    INSERT INTO "public"."BackgroundRuntimeConfig" ("id", "checkoutRecoveryLifetimeDays", "updatedAt")
    VALUES ('default', 21, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET "checkoutRecoveryLifetimeDays" = 21, "updatedAt" = CURRENT_TIMESTAMP
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
          UPDATE "commerce"."CheckoutRecovery" SET "generation" = 2, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${recoveryId} AND "checkoutToken" = ${checkoutToken}
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
    {
      name: "credential rotation",
      recoveryId: `arch055_rotation_${randomUUID()}`,
      checkoutToken: `checkout_rotation_${randomUUID()}`,
      mutate: async () => {
        const rotated = await mutator.wooCommerceInstallation.update({
          where: { id: installationId },
          data: { credentialDigest: Buffer.alloc(32, 0x54), credentialVersion: { increment: 1 } },
        });
        assert.equal(rotated.credentialVersion, 2);
      },
    },
  ];

  for (const scenario of scenarios) {
    await reader.$executeRaw`
      UPDATE "public"."BackgroundRuntimeConfig"
      SET "checkoutRecoveryLifetimeDays" = 21, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'default'
    `;
    await insertRecovery(scenario.recoveryId, scenario.checkoutToken);
    const [fixtureState] = await reader.$queryRaw<Array<{
      recoveryStatus: string | null;
      generation: number | null;
      shopStatus: string | null;
      platform: string | null;
      installationStatus: string | null;
      credentialVersion: number | null;
      lifetimeDays: number | null;
    }>>`
      SELECT cr."status"::text AS "recoveryStatus", cr."generation", s."status"::text AS "shopStatus",
        s."platform"::text AS "platform", i."status"::text AS "installationStatus",
        i."credentialVersion", config."checkoutRecoveryLifetimeDays" AS "lifetimeDays"
      FROM "commerce"."CheckoutRecovery" cr
      JOIN "commerce"."Shop" s ON s."id" = cr."shopId"
      JOIN "woocommerce"."WooCommerceInstallation" i ON i."shopId" = s."id"
      JOIN "public"."BackgroundRuntimeConfig" config ON config."id" = 'default'
      WHERE cr."id" = ${scenario.recoveryId}
    `;
    assert.deepEqual(fixtureState, {
      recoveryStatus: "DETECTED", generation: 1, shopStatus: "ACTIVE", platform: "WOOCOMMERCE",
      installationStatus: "ACTIVE", credentialVersion: 1, lifetimeDays: 21,
    });
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