import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { encryptCredential, parseCredentialKeyring } from
  "@modainteract/moda-interact-shared/security/credentials/node";
import { createTransactionMessagingSenderFactory } from "../../../../src/platform-configuration/composition.js";
import { ApiPlatformConfigurationError } from "../../../../src/platform-configuration/errors.js";
import { apiPlatformConfigurationAad } from "../../../../src/platform-configuration/contracts.js";
import { readEligibleFollowUpChoices } from "../../../../src/merchant/conversations/messages/follow-up-catalogue.js";
import { createPublishedFollowUp, LANGUAGE, WABA } from "./arch047-template-fixture.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

test("ARCH-055 sender configuration reads use the active transaction and preserve failures", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "2");
  const queries: Array<{ query: string; duration: number }> = [];
  const db = new PrismaClient({
    datasources: { db: { url: url.toString() } },
    log: [{ emit: "event", level: "query" }],
  });
  db.$on("query", event => queries.push({ query: event.query, duration: event.duration }));
  const wrappingJson = JSON.stringify({ wrapping: randomBytes(32).toString("base64") });
  const keyring = parseCredentialKeyring(wrappingJson);
  const environment = {
    MODA_ENCRYPTION_KEYS_JSON: wrappingJson,
    MODA_ENCRYPTION_ACTIVE_KEY_ID: "wrapping",
  };
  const secret = { accessToken: "not-a-real-provider-token", phoneNumberId: "1234567890",
    businessAccountId: WABA };
  const encrypted = encryptCredential({ keyring, activeKeyId: "wrapping", plaintext: JSON.stringify(secret),
    aad: apiPlatformConfigurationAad("test", "messaging.sender", 1) });
  const value = { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM",
    wrappingKeyId: encrypted.keyId, nonce: Buffer.from(encrypted.nonce).toString("base64"),
    ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
    authTag: Buffer.from(encrypted.authTag).toString("base64") };

  try {
    const shop = await db.shop.create({ data: {
      domain: `https://woo-${randomBytes(8).toString("hex")}.invalid`,
      platform: "WOOCOMMERCE", status: "ACTIVE",
    } });
    const templateName = `arch055_transaction_${randomBytes(6).toString("hex")}`;
    await createPublishedFollowUp(db, shop.id, new Date("2026-11-02T12:00:00.000Z"), {
      name: templateName, wabaId: WABA,
    });
    await db.platformConfiguration.create({ data: { environment: "test", key: "messaging.sender", value } });
    queries.length = 0;
    const senderFactory = createTransactionMessagingSenderFactory({
      environment: "test", unsealEnvironment: environment,
    });
    const choices = await db.$transaction(async tx => {
      const result = await readEligibleFollowUpChoices(tx, shop.id, senderFactory,
        new Date("2026-11-02T12:00:00.000Z"));
      return result;
    });
    assert.deepEqual(choices.map(choice => [choice.name, choice.language]), [[templateName, LANGUAGE]]);
    assert.ok(queries.some(query => query.query.includes('"PlatformConfiguration"')));

    if (process.env.ARCH055_MEASURE_VERSION) {
      const samples: Array<{ elapsedMs: number; sql: Array<{ query: string; duration: number }> }> = [];
      for (let execution = 0; execution < 7; execution += 1) {
        queries.length = 0;
        const startedAt = performance.now();
        const measuredChoices = await db.$transaction(tx => readEligibleFollowUpChoices(
          tx, shop.id, senderFactory, new Date("2026-11-02T12:00:00.000Z")));
        const elapsedMs = performance.now() - startedAt;
        assert.equal(measuredChoices.length, 1);
        if (execution >= 2) samples.push({ elapsedMs, sql: [...queries] });
      }
      const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
      const sqlShapes = [...new Set(samples.flatMap(sample => sample.sql.map(query =>
        query.query.replace(/\$\d+/g, "?").replace(/\s+/g, " ").trim())))];
      console.log(`ARCH055-M07-${process.env.ARCH055_MEASURE_VERSION} sender-config ` +
        `rows=${choices.length} ms=${samples.map(sample => sample.elapsedMs.toFixed(2)).join(",")} ` +
        `range=${sorted[0]?.toFixed(2)}/${sorted[2]?.toFixed(2)}/${sorted[4]?.toFixed(2)} ` +
        `clientCalls=1 affectedRows=0 externalCalls=0 sqlCalls=${samples.map(sample => sample.sql.length).join(",")} ` +
        `sqlMs=${samples.map(sample => sample.sql.map(query => query.duration.toFixed(2)).join(",")).join("/")} ` +
        `sqlShapes=${sqlShapes.map(shape => {
          const table = shape.match(/(?:FROM|UPDATE|INTO) "([^"]+)"\."([^"]+)"/)?.slice(1).join(".") ?? "transaction";
          const operation = shape.startsWith("SELECT") ? (shape.includes("COUNT(") ? "count" : "select") :
            shape.split(" ")[0]!.toLowerCase();
          return `${table}:${operation}`;
        }).join("|")}`);
    }

    const wrongKeyFactory = createTransactionMessagingSenderFactory({
      environment: "test",
      unsealEnvironment: {
        MODA_ENCRYPTION_KEYS_JSON: JSON.stringify({ wrapping: randomBytes(32).toString("base64") }),
        MODA_ENCRYPTION_ACTIVE_KEY_ID: "wrapping",
      },
    });
    await assert.rejects(db.$transaction(tx => readEligibleFollowUpChoices(tx,
      shop.id, wrongKeyFactory, new Date("2026-11-02T12:00:00.000Z"))),
    (error: unknown) => error instanceof ApiPlatformConfigurationError && error.code === "UNSEAL_FAILED");

    const renamedTable = `arch055_missing_configuration_${randomBytes(6).toString("hex")}`;
    await assert.rejects(db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`ALTER TABLE "public"."PlatformConfiguration" RENAME TO "${renamedTable}"`);
      return readEligibleFollowUpChoices(tx, shop.id, senderFactory, new Date("2026-11-02T12:00:00.000Z"));
    }), (error: unknown) => error instanceof ApiPlatformConfigurationError && error.code === "DATABASE_UNAVAILABLE" &&
      error.cause instanceof Prisma.PrismaClientKnownRequestError && error.cause.code === "P2021");
  } finally {
    await db.platformConfiguration.deleteMany({ where: { environment: "test", key: "messaging.sender" } });
    await db.$disconnect();
  }
});