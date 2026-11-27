import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { inspect } from "node:util";
import test from "node:test";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  ADMIN_ID,
  WABA,
  commonWrapperFixture,
  languages,
  recoveryDefaultFixture,
} from "../../../fixtures/recovery-defaults.js";
import {
  ONBOARDING_TEMPLATE_PURPOSES,
  assignOnePurpose,
} from "../../../../src/merchant/recovery-templates/publication.js";
import {
  RECOVERY_TEMPLATE_FORMATS,
  recoveryTemplateFormat,
} from "../../../../src/merchant/recovery-templates/format.js";
import { WooRecoveryTemplateProvisioner } from "../../../../src/merchant/recovery-templates/provisioner.js";

const databaseUrl = process.env.WOO_INSTALLATION_TEST_DATABASE_URL;

test(
  "PostgreSQL: WooCommerce inherits both approved formats, preserves IMAGE and rolls back partial writes",
  { skip: !databaseUrl },
  async () => {
    assert.ok(databaseUrl);
    // This fixture runs serially. Keep its pool small and allow bounded time for
    // Colima's connection forwarding; do not change any production client options.
    const fixtureUrl = new URL(databaseUrl);
    fixtureUrl.searchParams.set("connection_limit", "1");
    fixtureUrl.searchParams.set("pool_timeout", "30");
    fixtureUrl.searchParams.set("connect_timeout", "15");
    const db = new PrismaClient({
      datasources: { db: { url: fixtureUrl.toString() } },
    });
    const startedAt = performance.now();
    let phase = "connecting fixture client";
    try {
      await db.$connect();
      await db.$queryRaw`SELECT 1`;
      phase = "seeding platform administrator";
      await db.platformAdmin.create({
        data: {
          id: ADMIN_ID,
          email: `${randomUUID()}@example.invalid`,
          role: "SUPER_ADMIN",
        },
      });
      const wrapper = commonWrapperFixture();
      const { locales: commonLocales, ...common } = wrapper;
      const definitions = new Map<string, string>();
      const definitionRows: Prisma.WhatsAppTemplateDefinitionCreateManyInput[] =
        [{ ...common, createdByAdminId: ADMIN_ID }];
      const localeRows: Prisma.WhatsAppTemplateLocaleCreateManyInput[] =
        commonLocales.map((locale) => ({
          ...locale,
          definitionId: common.id,
          localeAst: locale.localeAst as Prisma.InputJsonValue,
        }));
      const registrationRows: Prisma.WhatsAppTemplateMetaRegistrationCreateManyInput[] =
        [];
      const imageDefaults: Prisma.WhatsAppRecoveryTemplateDefaultCreateManyInput[] =
        [];
      const textDefaults: Prisma.WhatsAppRecoveryTemplateDefaultCreateManyInput[] =
        [];
      for (const purpose of ONBOARDING_TEMPLATE_PURPOSES)
        for (const format of RECOVERY_TEMPLATE_FORMATS) {
          const { locales, ...definition } = recoveryDefaultFixture(
            purpose,
            format,
            wrapper,
            format === "IMAGE",
          );
          definitions.set(`${purpose}:${format}`, definition.id);
          definitionRows.push({ ...definition, createdByAdminId: ADMIN_ID });
          for (const { metaRegistrations, ...locale } of locales) {
            localeRows.push({
              ...locale,
              localeAst: locale.localeAst as Prisma.InputJsonValue,
            });
            for (const reg of metaRegistrations)
              registrationRows.push({
                ...reg,
                componentsSnapshot:
                  reg.componentsSnapshot as Prisma.InputJsonValue,
                parameterBindingsSnapshot:
                  reg.parameterBindingsSnapshot as Prisma.InputJsonValue,
              });
          }
          const pointer = {
            wabaId: WABA,
            purpose,
            format,
            definitionId: definition.id,
            updatedByAdminId: ADMIN_ID,
          };
          (format === "IMAGE" ? imageDefaults : textDefaults).push(pointer);
        }
      assert.equal(definitions.size, 12);
      assert.equal(definitionRows.length, 13);
      assert.equal(localeRows.length, 260);
      assert.equal(registrationRows.length, 240);
      assert.equal(imageDefaults.length, 6);
      assert.equal(textDefaults.length, 6);
      // Seed identical immutable evidence in FK order, without hundreds of
      // separate round trips. Do not skip duplicates or weaken any constraints.
      phase = "bulk inserting template definitions";
      assert.equal(
        (
          await db.whatsAppTemplateDefinition.createMany({
            data: definitionRows,
          })
        ).count,
        13,
      );
      phase = "bulk inserting template locales";
      assert.equal(
        (await db.whatsAppTemplateLocale.createMany({ data: localeRows }))
          .count,
        260,
      );
      phase = "bulk inserting Meta registrations";
      assert.equal(
        (
          await db.whatsAppTemplateMetaRegistration.createMany({
            data: registrationRows,
          })
        ).count,
        240,
      );
      phase = "activating common layout";
      await db.whatsAppConversationWrapperActiveSlot.create({
        data: {
          audience: "SHARED",
          definitionId: common.id,
          updatedByAdminId: ADMIN_ID,
        },
      });
      // IMAGE first simulates an existing merchant before TEXT is configured.
      phase = "seeding IMAGE defaults";
      assert.equal(
        (
          await db.whatsAppRecoveryTemplateDefault.createMany({
            data: imageDefaults,
          })
        ).count,
        6,
      );
      console.info(
        `Recovery template fixture seeded in ${Math.round(performance.now() - startedAt)}ms`,
      );
      phase = "creating WooCommerce merchant and installation";
      const shop = await db.shop.create({
        data: {
          domain: `https://${randomUUID()}.woo-test.invalid`,
          platform: "WOOCOMMERCE",
          status: "ACTIVE",
          onboardingCompleted: true,
        },
      });
      const install = await db.wooCommerceInstallation.create({
        data: {
          shopId: shop.id,
          canonicalSiteUrl: shop.domain,
          credentialDigest: Uint8Array.from(Buffer.alloc(32, 7)),
        },
      });
      const principal = {
        shopId: shop.id,
        installationId: install.id,
        canonicalSiteUrl: shop.domain,
        credentialVersion: install.credentialVersion,
      };
      const context = { environment: "test", readSenderWaba: async () => WABA };
      for (const purpose of ONBOARDING_TEMPLATE_PURPOSES) {
        phase = `seeding existing IMAGE assignment: ${purpose}`;
        assert.equal(
          await db.$transaction((tx) =>
            assignOnePurpose(tx, principal, purpose, WABA, "IMAGE", context),
          ),
          "ASSIGNED",
          phase,
        );
      }
      const before = await db.whatsAppTemplateVariant.findMany({
        where: { shopId: shop.id },
        orderBy: { id: "asc" },
      });
      assert.equal(before.length, 120);
      phase = "seeding TEXT defaults";
      assert.equal(
        (
          await db.whatsAppRecoveryTemplateDefault.createMany({
            data: textDefaults,
          })
        ).count,
        6,
      );
      // Record the actual per-slot outcome and the original Error (including Prisma
      // code/meta) from the disposable fixture, without changing the production
      // timeout, frozen test clock, incident stub or provisioning behaviour.
      const provisioningEvents: Array<{
        elapsedMs: number;
        event: string;
        fields: unknown;
      }> = [];
      let provisionStartedAt = performance.now();
      const capture = (event: string, fields?: unknown) => {
        provisioningEvents.push({
          elapsedMs: Math.round(performance.now() - provisionStartedAt),
          event,
          fields,
        });
      };
      const provisioner = new WooRecoveryTemplateProvisioner({
        database: db,
        environment: "test",
        sender: () => ({ readMessagingSenderWabaId: async () => WABA }),
        logger: { info: capture, warn: capture, error: capture },
        reporter: {
          report: async () => {
            throw new Error("Unexpected provisioning incident");
          },
        },
        now: () => 0,
      });
      // Force a real transaction failure after creating variants, before commit.
      phase = "checking transaction rollback";
      const first = ONBOARDING_TEMPLATE_PURPOSES[0];
      await assert.rejects(
        db.$transaction(async (tx) => {
          assert.equal(
            await assignOnePurpose(tx, principal, first, WABA, "TEXT", context),
            "ASSIGNED",
          );
          throw new Error("injected rollback");
        }),
        /injected rollback/,
      );
      assert.equal(
        await db.whatsAppTemplateVariant.count({ where: { shopId: shop.id } }),
        120,
      );
      phase = "provisioning missing TEXT assignments";
      provisionStartedAt = performance.now();
      await provisioner.provision(principal);
      const rows = await db.whatsAppTemplateVariant.findMany({
        where: { shopId: shop.id },
        include: { metaRegistration: true },
      });
      const formatCounts = ONBOARDING_TEMPLATE_PURPOSES.flatMap((purpose) =>
        RECOVERY_TEMPLATE_FORMATS.map((format) => {
          const assigned = rows.filter(
            (row) =>
              row.purpose === purpose &&
              recoveryTemplateFormat(
                row.metaRegistration?.componentsSnapshot,
              ) === format,
          );
          const assignedLanguages = new Set(
            assigned.map((row) => row.languageTag),
          );
          return {
            purpose,
            format,
            count: assigned.length,
            missingLanguages: languages.filter(
              (language) => !assignedLanguages.has(language),
            ),
          };
        }),
      );
      if (
        rows.length !== 240 ||
        formatCounts.some(
          (slot) => slot.count !== 20 || slot.missingLanguages.length !== 0,
        )
      ) {
        console.error(
          "WooCommerce recovery provisioning diagnostics:\n%s",
          inspect(
            {
              elapsedMs: Math.round(performance.now() - provisionStartedAt),
              totalVariants: rows.length,
              expectedVariants: 240,
              retainedOriginalImageRows: before.filter((original) =>
                rows.some((row) => row.id === original.id),
              ).length,
              formatCounts,
              outcomes: provisioningEvents,
            },
            {
              depth: 6,
              colors: false,
              maxArrayLength: null,
              maxStringLength: null,
            },
          ),
        );
      }
      phase = "checking complete assignment coverage";
      assert.equal(rows.length, 240);
      for (const slot of formatCounts)
        assert.deepEqual(
          slot.missingLanguages,
          [],
          `${slot.purpose}:${slot.format}`,
        );
      assert.equal(
        await db.whatsAppTemplatePublicationTarget.count({
          where: { shopId: shop.id },
        }),
        240,
      );
      for (const purpose of ONBOARDING_TEMPLATE_PURPOSES)
        for (const format of RECOVERY_TEMPLATE_FORMATS)
          assert.equal(
            rows.filter(
              (r) =>
                r.purpose === purpose &&
                recoveryTemplateFormat(
                  r.metaRegistration?.componentsSnapshot,
                ) === format,
            ).length,
            20,
          );
      const afterImage = await db.whatsAppTemplateVariant.findMany({
        where: { id: { in: before.map((r) => r.id) } },
        orderBy: { id: "asc" },
      });
      assert.deepEqual(afterImage, before);
      phase = "checking idempotent reconnect";
      await provisioner.provision(principal);
      assert.equal(
        await db.whatsAppTemplateVariant.count({ where: { shopId: shop.id } }),
        240,
      );
      phase = "checking stale installation credentials";
      await db.wooCommerceInstallation.update({
        where: { id: install.id },
        data: { credentialVersion: { increment: 1 } },
      });
      assert.equal(
        await db.$transaction((tx) =>
          assignOnePurpose(tx, principal, first, WABA, "TEXT", context),
        ),
        "SHOP_INELIGIBLE",
      );
    } catch (error) {
      console.error("WooCommerce recovery fixture/test failed", {
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        error,
      });
      throw error;
    } finally {
      await db.$disconnect();
    }
  },
);
