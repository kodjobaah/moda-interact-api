import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { WooConfirmedSentOfferResolver } from "../../../../src/woocommerce/recovery-restore/offer-resolver.js";
import { WooRecoveryRestoreService } from "../../../../src/woocommerce/recovery-restore/service.js";

const databaseUrl = process.env.ARCH053_WOO_RESTORE_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("ARCH053_WOO_RESTORE_TEST_DATABASE_URL is required");

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const now = new Date();
const shopId = "restore_shop";
const installationId = "restore_installation";
const canonicalSiteUrl = "https://merchant.example/store";
const checkoutToken = "same_checkout_token";
const principal = { shopId, installationId, canonicalSiteUrl, credentialVersion: 3 };

function token(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function storedUrl(recoveryId: string, value: string): string {
  return `${canonicalSiteUrl}/?moda_interact_resume=1&r=${recoveryId}&t=${value}`;
}

async function insertRecovery(input: {
  id: string; token: string; checkoutToken: string; generation: number; status: string;
  lastActivityAt: Date; snapshot: unknown; completedAt?: Date | null; expiredAt?: Date | null;
}) {
  await prisma.$executeRaw`
    INSERT INTO "commerce"."CheckoutRecovery"
      ("id", "shopId", "checkoutToken", "generation", "status", "completedAt", "expiredAt",
       "lastExternalActivityAt", "checkoutUrl", "wooRestoreSnapshot")
    VALUES (${input.id}, ${shopId}, ${input.checkoutToken}, ${input.generation}, ${input.status},
      ${input.completedAt ?? null}, ${input.expiredAt ?? null}, ${input.lastActivityAt},
      ${storedUrl(input.id, input.token)}, CAST(${JSON.stringify(input.snapshot)} AS jsonb))
  `;
}

async function insertConversation(recoveryId: string, conversationId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "whatsapp"."Conversation" ("id", "checkoutRecoveryId")
    VALUES (${conversationId}, ${recoveryId})
  `;
}

async function insertAttempt(input: {
  recoveryId: string;
  conversationId: string;
  attemptId: string;
  sequence?: number;
  status: string;
  sentAt: Date | null;
  outboundMessageId: string | null;
  message?: { id: string; status: string; providerMessageId: string | null; content: string };
}): Promise<void> {
  if (input.message) {
    await prisma.$executeRaw`
      INSERT INTO "whatsapp"."ConversationMessage"
        ("id", "conversationId", "direction", "senderType", "status", "providerMessageId", "content")
      VALUES (${input.message.id}, ${input.conversationId}, 'OUTBOUND', 'AUTOMATION',
        ${input.message.status}, ${input.message.providerMessageId}, ${input.message.content})
    `;
  }
  await prisma.$executeRaw`
    INSERT INTO "commerce"."RecoveryOutreachAttempt"
      ("id", "checkoutRecoveryId", "sequence", "status", "sentAt", "outboundMessageId")
    VALUES (${input.attemptId}, ${input.recoveryId}, ${input.sequence ?? 1}, ${input.status},
      ${input.sentAt}, ${input.outboundMessageId})
  `;
}

after(async () => prisma.$disconnect());

test("PostgreSQL resolver query enforces latest generation and returns coupon codes only as snapshot data", async () => {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "commerce"`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "woocommerce"`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "whatsapp"`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "public"."BackgroundRuntimeConfig" (
      "id" text PRIMARY KEY, "checkoutRecoveryLifetimeDays" integer NOT NULL,
      CONSTRAINT "ck_arch016_checkout_recovery_lifetime"
        CHECK ("checkoutRecoveryLifetimeDays" BETWEEN 1 AND 90)
    )
  `);
  await prisma.$executeRaw`
    INSERT INTO "public"."BackgroundRuntimeConfig" ("id", "checkoutRecoveryLifetimeDays")
    VALUES ('default', 21)
  `;
  const migrationPath = new URL(
    "../../../../database/prisma/migrations/20261031110000_arch016_remove_recovery_lifetime_check/migration.sql",
    import.meta.url,
  );
  const originalConstraint = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'ck_arch016_checkout_recovery_lifetime'
        AND conrelid = '"public"."BackgroundRuntimeConfig"'::regclass
    ) AS "exists"
  `;
  assert.equal(originalConstraint[0]?.exists, true);
  await prisma.$executeRawUnsafe(readFileSync(migrationPath, "utf8"));
  const removedConstraint = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'ck_arch016_checkout_recovery_lifetime'
        AND conrelid = '"public"."BackgroundRuntimeConfig"'::regclass
    ) AS "exists"
  `;
  assert.equal(removedConstraint[0]?.exists, false);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "commerce"."Shop" (
      "id" text PRIMARY KEY, "domain" text NOT NULL, "status" text NOT NULL,
      "platform" text NOT NULL, "shopifyShopId" text
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "woocommerce"."WooCommerceInstallation" (
      "id" text PRIMARY KEY, "shopId" text NOT NULL, "canonicalSiteUrl" text NOT NULL,
      "status" text NOT NULL, "credentialVersion" integer NOT NULL, "revokedAt" timestamptz
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "commerce"."CheckoutRecovery" (
      "id" text PRIMARY KEY, "shopId" text NOT NULL, "checkoutToken" text NOT NULL,
      "generation" integer NOT NULL, "status" text NOT NULL, "completedAt" timestamptz,
      "expiredAt" timestamptz, "lastExternalActivityAt" timestamptz NOT NULL,
      "checkoutUrl" text, "wooRestoreSnapshot" jsonb
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "whatsapp"."Conversation" (
      "id" text PRIMARY KEY, "checkoutRecoveryId" text UNIQUE
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "whatsapp"."ConversationMessage" (
      "id" text PRIMARY KEY, "conversationId" text NOT NULL, "direction" text NOT NULL,
      "senderType" text NOT NULL, "status" text NOT NULL, "providerMessageId" text, "content" text NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "commerce"."RecoveryOutreachAttempt" (
      "id" text PRIMARY KEY, "checkoutRecoveryId" text NOT NULL, "sequence" integer NOT NULL,
      "status" text NOT NULL, "sentAt" timestamptz, "outboundMessageId" text,
      UNIQUE ("checkoutRecoveryId", "sequence")
    )
  `);
  await prisma.$executeRaw`
    INSERT INTO "commerce"."Shop" ("id", "domain", "status", "platform", "shopifyShopId")
    VALUES (${shopId}, ${canonicalSiteUrl}, 'ACTIVE', 'WOOCOMMERCE', NULL)
  `;
  await prisma.$executeRaw`
    INSERT INTO "woocommerce"."WooCommerceInstallation"
      ("id", "shopId", "canonicalSiteUrl", "status", "credentialVersion", "revokedAt")
    VALUES (${installationId}, ${shopId}, ${canonicalSiteUrl}, 'ACTIVE', 3, NULL)
  `;
  await prisma.$executeRaw`
    INSERT INTO "commerce"."Shop" ("id", "domain", "status", "platform", "shopifyShopId")
    VALUES ('other_shop', 'https://other.example', 'ACTIVE', 'WOOCOMMERCE', NULL)
  `;
  await prisma.$executeRaw`
    INSERT INTO "woocommerce"."WooCommerceInstallation"
      ("id", "shopId", "canonicalSiteUrl", "status", "credentialVersion", "revokedAt")
    VALUES ('other_installation', 'other_shop', 'https://other.example', 'ACTIVE', 1, NULL)
  `;

  const originalSnapshot = {
    schemaVersion: "woo.cart-restore.v1", kind: "supported", appliedCouponCodes: ["EXPIRED10"],
    lines: [{ productId: "101", quantity: 2 }],
  };
  const priorToken = token(1);
  const currentToken = token(2);
  const unsupportedToken = token(3);
  const staleToken = token(4);
  const eightDaysToken = token(6);
  const futureActivityToken = token(9);
  await insertRecovery({ id: "restore_old_generation", token: priorToken, checkoutToken,
    generation: 1, status: "COMPLETED", completedAt: now, lastActivityAt: now, snapshot: originalSnapshot });
  await insertRecovery({ id: "restore_current_generation", token: currentToken, checkoutToken,
    generation: 2, status: "MESSAGE_SENT", lastActivityAt: new Date(now.getTime() - 60_000),
    snapshot: originalSnapshot });
  await insertRecovery({ id: "restore_unsupported", token: unsupportedToken, checkoutToken: "unsupported_checkout",
    generation: 1, status: "DETECTED", lastActivityAt: now,
    snapshot: { schemaVersion: "woo.cart-restore.v1", kind: "unsupported", reason: "ITEMS_UNAVAILABLE",
      appliedCouponCodes: ["EXPIRED10"] } });
  await insertRecovery({ id: "restore_stale", token: staleToken, checkoutToken: "stale_checkout",
    generation: 1, status: "DETECTED", lastActivityAt: new Date(now.getTime() - 22 * 24 * 60 * 60 * 1000),
    snapshot: originalSnapshot });
  await insertRecovery({ id: "restore_eight_days", token: eightDaysToken, checkoutToken: "eight_days_checkout",
    generation: 1, status: "DETECTED", lastActivityAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
    snapshot: originalSnapshot });
  await insertRecovery({ id: "restore_future_activity", token: futureActivityToken,
    checkoutToken: "future_activity_checkout", generation: 1, status: "DETECTED",
    lastActivityAt: new Date(now.getTime() + 1), snapshot: originalSnapshot });
  const confirmedOfferSet = {
    schemaVersion: "moda.outreach.checkout-offers.v1",
    offers: [
      { offerId: "offer-one", providerDiscountId: "discount-one", method: "CODE", code: "SAVE15" },
      { offerId: "offer-two", providerDiscountId: "discount-two", method: "AUTOMATIC", code: null },
    ],
  };
  const confirmedReceipt = JSON.stringify({
    contract: "moda.whatsapp.automated-template-parameters.v1",
    recoveryPromise: {
      kind: "CHECKOUT_DISCOUNT", promotionTarget: "CHECKOUT", offerSet: confirmedOfferSet,
    },
  });
  await insertConversation("restore_old_generation", "conversation_old_generation");
  await insertAttempt({
    recoveryId: "restore_old_generation", conversationId: "conversation_old_generation",
    attemptId: "attempt_old_generation", status: "WAITING_FOR_RESPONSE", sentAt: now,
    outboundMessageId: "message_old_generation",
    message: { id: "message_old_generation", status: "SENT", providerMessageId: "provider_old", content: confirmedReceipt },
  });
  await insertConversation("restore_current_generation", "conversation_current_generation");
  await insertAttempt({
    recoveryId: "restore_current_generation", conversationId: "conversation_current_generation",
    attemptId: "attempt_current_generation", status: "WAITING_FOR_RESPONSE", sentAt: now,
    outboundMessageId: "message_current_generation",
    message: { id: "message_current_generation", status: "DELIVERED", providerMessageId: "provider_current", content: confirmedReceipt },
  });
  const failedToken = token(10);
  await insertRecovery({ id: "restore_failed_attempt", token: failedToken, checkoutToken: "failed_checkout",
    generation: 1, status: "DETECTED", lastActivityAt: now, snapshot: originalSnapshot });
  await insertConversation("restore_failed_attempt", "conversation_failed_attempt");
  await insertAttempt({ recoveryId: "restore_failed_attempt", conversationId: "conversation_failed_attempt",
    attemptId: "attempt_failed", status: "FAILED", sentAt: null, outboundMessageId: null });
  const unconfirmedToken = token(11);
  await insertRecovery({ id: "restore_unconfirmed_attempt", token: unconfirmedToken,
    checkoutToken: "unconfirmed_checkout", generation: 1, status: "DETECTED", lastActivityAt: now,
    snapshot: originalSnapshot });
  await insertConversation("restore_unconfirmed_attempt", "conversation_unconfirmed_attempt");
  await insertAttempt({
    recoveryId: "restore_unconfirmed_attempt", conversationId: "conversation_unconfirmed_attempt",
    attemptId: "attempt_unconfirmed", status: "PENDING", sentAt: null,
    outboundMessageId: "message_unconfirmed",
    message: { id: "message_unconfirmed", status: "PENDING", providerMessageId: null, content: confirmedReceipt },
  });
  const duplicateToken = token(12);
  await insertRecovery({ id: "restore_duplicate_offer", token: duplicateToken,
    checkoutToken: "duplicate_offer_checkout", generation: 1, status: "DETECTED", lastActivityAt: now,
    snapshot: originalSnapshot });
  await insertConversation("restore_duplicate_offer", "conversation_duplicate_offer");
  const duplicateOfferSet = {
    ...confirmedOfferSet,
    offers: [
      confirmedOfferSet.offers[0],
      { ...confirmedOfferSet.offers[1], providerDiscountId: "discount-one" },
    ],
  };
  await insertAttempt({
    recoveryId: "restore_duplicate_offer", conversationId: "conversation_duplicate_offer",
    attemptId: "attempt_duplicate_offer", status: "WAITING_FOR_RESPONSE", sentAt: now,
    outboundMessageId: "message_duplicate_offer",
    message: { id: "message_duplicate_offer", status: "READ", providerMessageId: "provider_duplicate",
      content: JSON.stringify({ contract: "moda.whatsapp.automated-template-parameters.v1",
        recoveryPromise: { kind: "CHECKOUT_DISCOUNT", promotionTarget: "CHECKOUT", offerSet: duplicateOfferSet } }) },
  });
  await prisma.$executeRaw`
    INSERT INTO "commerce"."CheckoutRecovery"
      ("id", "shopId", "checkoutToken", "generation", "status", "lastExternalActivityAt",
       "checkoutUrl", "wooRestoreSnapshot")
    VALUES ('restore_other_shop', 'other_shop', 'other_checkout', 1, 'DETECTED', ${now},
      ${`https://other.example/?moda_interact_resume=1&r=restore_other_shop&t=${token(5)}`},
      CAST(${JSON.stringify(originalSnapshot)} AS jsonb))
  `;

  const resolver = new WooRecoveryRestoreService(prisma, new WooConfirmedSentOfferResolver(prisma, {
    warn() {},
  } as never), () => now);
  const current = await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_current_generation", token: currentToken,
  });
  assert.ok(current);
  assert.deepEqual(current.snapshot, originalSnapshot);
  assert.deepEqual(current.outreachOffer, {
    kind: "CHECKOUT_OFFERS",
    offers: [
      { method: "CODE", providerDiscountId: "discount-one", code: "SAVE15" },
      { method: "AUTOMATIC", providerDiscountId: "discount-two" },
    ],
  });
  for (const [id, tokenValue] of [
    ["restore_failed_attempt", failedToken],
    ["restore_unconfirmed_attempt", unconfirmedToken],
  ] as const) {
    const result = await resolver.resolve(principal, {
      schemaVersion: "woo.restore.resolve.v1", recoveryId: id, token: tokenValue,
    });
    assert.deepEqual(result?.outreachOffer, { kind: "NONE", reason: "NO_CONFIRMED_OFFER" });
  }
  const duplicateOffer = await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_duplicate_offer", token: duplicateToken,
  });
  assert.deepEqual(duplicateOffer?.outreachOffer, { kind: "NONE", reason: "UNVERIFIABLE" });
  assert.ok(await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_eight_days", token: eightDaysToken,
  }));
  assert.equal(await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_old_generation", token: priorToken,
  }), null);
  assert.equal(await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_unsupported", token: unsupportedToken,
  }), null);
  assert.equal(await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_stale", token: staleToken,
  }), null);
  assert.equal(await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_future_activity", token: futureActivityToken,
  }), null);
  assert.equal(await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_other_shop", token: token(5),
  }), null);

  for (const lifetimeDays of [1, 21, 91, 180, 365, 2_147_483_647]) {
    await prisma.$executeRaw`
      UPDATE "public"."BackgroundRuntimeConfig"
      SET "checkoutRecoveryLifetimeDays" = ${lifetimeDays} WHERE "id" = 'default'
    `;
    assert.ok(await resolver.resolve(principal, {
      schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_current_generation", token: currentToken,
    }));
  }

  const beforeCutoffToken = token(7);
  const atCutoffToken = token(8);
  await insertRecovery({ id: "restore_before_cutoff", token: beforeCutoffToken, checkoutToken: "before_cutoff",
    generation: 1, status: "DETECTED", lastActivityAt: new Date(now.getTime() - 86_400_000 + 1),
    snapshot: originalSnapshot });
  await insertRecovery({ id: "restore_at_cutoff", token: atCutoffToken, checkoutToken: "at_cutoff",
    generation: 1, status: "DETECTED", lastActivityAt: new Date(now.getTime() - 86_400_000),
    snapshot: originalSnapshot });
  await prisma.$executeRaw`
    UPDATE "public"."BackgroundRuntimeConfig"
    SET "checkoutRecoveryLifetimeDays" = 1 WHERE "id" = 'default'
  `;
  assert.ok(await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_before_cutoff", token: beforeCutoffToken,
  }));
  assert.equal(await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_at_cutoff", token: atCutoffToken,
  }), null);

  await prisma.$executeRaw`
    UPDATE "public"."BackgroundRuntimeConfig"
    SET "checkoutRecoveryLifetimeDays" = 0 WHERE "id" = 'default'
  `;
  assert.equal(await resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_current_generation", token: currentToken,
  }), null);
  await prisma.$executeRaw`
    UPDATE "public"."BackgroundRuntimeConfig"
    SET "checkoutRecoveryLifetimeDays" = -1 WHERE "id" = 'default'
  `;
  await assert.rejects(resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "restore_current_generation", token: currentToken,
  }), /Invalid checkout recovery lifetime configuration/);
  await prisma.$executeRaw`DELETE FROM "public"."BackgroundRuntimeConfig" WHERE "id" = 'default'`;
  await assert.rejects(resolver.resolve(principal, {
    schemaVersion: "woo.restore.resolve.v1", recoveryId: "missing_recovery", token: currentToken,
  }), /Invalid checkout recovery lifetime configuration/);
});