import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_ID, WABA, commonWrapperFixture, languages, recoveryDefaultFixture } from "../../../fixtures/recovery-defaults.js";
import { assignOnePurpose, ONBOARDING_TEMPLATE_PURPOSES, type OnboardingTemplatePurpose } from "../../../../src/merchant/recovery-templates/publication.js";
import { recoveryTemplateFormat, RECOVERY_TEMPLATE_FORMATS, type RecoveryTemplateFormat } from "../../../../src/merchant/recovery-templates/format.js";
import { WooRecoveryTemplateProvisioner } from "../../../../src/merchant/recovery-templates/provisioner.js";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";

const principal: WooInstallationPrincipal = { shopId: "shop-woo-test", installationId: "install-test", canonicalSiteUrl: "https://merchant.example", credentialVersion: 2 };
const firstPurpose = ONBOARDING_TEMPLATE_PURPOSES[0];
type Definition = ReturnType<typeof recoveryDefaultFixture>;
type Registration = Definition["locales"][number]["metaRegistrations"][number];
type Variant = { id: string; purpose: string; providerAccountId: string; languageTag: string; metaRegistrationId: string;
  enabled: boolean; status: string; metaRegistration: Registration };
type Target = { newVariantId: string; languageTag: string; metaRegistrationId: string };
type Pointer = { id: string; definitionId: string; updatedByAdminId: string; updatedAt: Date };
type VariantFilter = { purpose: string; providerAccountId?: string; enabled?: boolean; status?: string; metaRegistrationId?: { in: string[] } };
function fixture(options: { image?: boolean; text?: boolean; common?: boolean } = {}) {
  const common = options.common ? commonWrapperFixture() : undefined;
  let activeCommon = common;
  const definitions = new Map<string, Definition>(); const pointers = new Map<string, Pointer>();
  const rows: Variant[] = []; const targets: Target[] = []; const operations: unknown[] = [];
  const reports: Record<string, unknown>[] = []; const logs: Record<string, unknown>[] = [];
  let credentialVersion = principal.credentialVersion;
  const add = (purpose: OnboardingTemplatePurpose, format: RecoveryTemplateFormat, revision: string = format, variable = "shop.name") => {
    const def = recoveryDefaultFixture(purpose, revision, common, format === "IMAGE", variable);
    definitions.set(def.id, def); pointers.set(`${purpose}:${format}`, { id: `pointer-${purpose}-${format}`, definitionId: def.id, updatedByAdminId: ADMIN_ID, updatedAt: new Date() });
    return def;
  };
  for (const purpose of ONBOARDING_TEMPLATE_PURPOSES) {
    if (options.text !== false) add(purpose, "TEXT");
    if (options.image) add(purpose, "IMAGE");
  }
  let senderWaba = WABA;
  const tx = {
    $queryRaw: async (query: TemplateStringsArray | { strings: string[] }, ...args: unknown[]) => {
      const sql = (Array.isArray(query) ? query : (query as { strings: string[] }).strings).join("?");
      if (sql.includes('"whatsapp"."WhatsAppTemplateMetaRegistration"')) return definitions.get(String(args[0]))?.locales.flatMap(l => l.metaRegistrations.filter(r => r.wabaId === args[1]).map(r => ({ id: r.id }))) ?? [];
      if (sql.includes('"whatsapp"."WhatsAppTemplateLocale"')) return definitions.get(String(args[0]))?.locales.map(l => ({ id: l.id })) ?? [];
      return [{ id: "locked" }];
    },
    shop: { findUnique: async () => ({ id: principal.shopId, domain: principal.canonicalSiteUrl, status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null, onboardingCompleted: true }) },
    wooCommerceInstallation: { findUnique: async () => ({ id: principal.installationId, shopId: principal.shopId, canonicalSiteUrl: principal.canonicalSiteUrl, status: "ACTIVE", revokedAt: null, credentialVersion }) },
    whatsAppRecoveryTemplateDefault: { findUnique: async ({ where }: { where: { wabaId_purpose_format: { wabaId: string; purpose: string; format: string } } }) => {
      const key = where.wabaId_purpose_format; return key.wabaId === WABA ? pointers.get(`${key.purpose}:${key.format}`) ?? null : null;
    } },
    whatsAppTemplateDefinition: { findUnique: async ({ where }: { where: { id: string } }) => definitions.get(where.id) ?? null },
    whatsAppConversationWrapperActiveSlot: { findUnique: async () => activeCommon ? { definitionId: activeCommon.id, definition: activeCommon } : null },
    whatsAppTemplateVariant: {
      findMany: async ({ where }: { where: VariantFilter }) => rows.filter(r => r.purpose === where.purpose &&
        (!where.providerAccountId || r.providerAccountId === where.providerAccountId) &&
        (where.enabled === undefined || r.enabled === where.enabled) && (!where.status || r.status === where.status) &&
        (!where.metaRegistrationId || where.metaRegistrationId.in.includes(r.metaRegistrationId))),
      createMany: async ({ data }: { data: Omit<Variant, "id" | "metaRegistration">[] }) => {
        for (const item of data) {
          const reg = [...definitions.values()].flatMap(d => d.locales.flatMap(l => l.metaRegistrations)).find(r => r.id === item.metaRegistrationId);
          assert.ok(reg); rows.push({ ...item, id: `variant-${rows.length}`, metaRegistration: structuredClone(reg) });
        }
        return { count: data.length };
      },
    },
    whatsAppTemplatePublicationOperation: { create: async ({ data }: { data: unknown }) => { operations.push(data); return { id: `operation-${operations.length}` }; } },
    whatsAppTemplatePublicationTarget: {
      findMany: async ({ where }: { where: { newVariantId: { in: string[] } } }) => targets.filter(r => where.newVariantId.in.includes(r.newVariantId)),
      createMany: async ({ data }: { data: Target[] }) => { targets.push(...data); return { count: data.length }; },
    },
  };
  const database = { $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) };
  const sender = () => ({ readMessagingSenderWabaId: async () => senderWaba });
  const logger = { info: (_event: string, fields: Record<string, unknown>) => { logs.push(fields); }, warn: (_event: string, fields: Record<string, unknown>) => { logs.push(fields); }, error: (_event: string, fields: Record<string, unknown>) => { logs.push(fields); } };
  const reporter = { report: async (data: unknown) => { reports.push(data as Record<string, unknown>); return null; } };
  const provisioner = new WooRecoveryTemplateProvisioner({ database: database as never, environment: "test", sender, logger, reporter, now: () => 0 });
  return { tx, rows, targets, operations, reports, logs, add, pointers, definitions, provisioner,
    setCredentialVersion: (v: number) => { credentialVersion = v; }, setSender: (v: string) => { senderWaba = v; },
    setCommon: (v: typeof common) => { activeCommon = v; }, assign: (format: RecoveryTemplateFormat = "TEXT") => assignOnePurpose(tx as never, principal, firstPurpose, WABA, format, { environment: "test", readSenderWaba: async () => senderWaba }) };
}

test("WooCommerce provisions 240 language assignments and preserves exact rows on retry", async () => {
  const f = fixture({ image: true, common: true });
  await f.provisioner.provision(principal);
  assert.equal(f.rows.length, 240); assert.equal(f.targets.length, 240); assert.equal(f.operations.length, 12);
  for (const purpose of ONBOARDING_TEMPLATE_PURPOSES) for (const format of RECOVERY_TEMPLATE_FORMATS) {
    assert.deepEqual(f.rows.filter(r => r.purpose === purpose && recoveryTemplateFormat(r.metaRegistration.componentsSnapshot) === format).map(r => r.languageTag).sort(), [...languages].sort());
  }
  const first = f.operations[0] as { scopeSnapshot: { automatedOnboarding: { platform: string; format: string; source: string } } };
  assert.deepEqual([first.scopeSnapshot.automatedOnboarding.platform, first.scopeSnapshot.automatedOnboarding.format, first.scopeSnapshot.automatedOnboarding.source], ["WOOCOMMERCE", "TEXT", "PLATFORM_RECOVERY_DEFAULT"]);
  const before = structuredClone(f.rows); await f.provisioner.provision(principal);
  assert.deepEqual(f.rows, before); assert.equal(f.operations.length, 12); assert.equal(f.reports.length, 0);
});
test("missing optional IMAGE does not report incident; missing TEXT is reported without blocking other format", async () => {
  const text = fixture(); await text.provisioner.provision(principal); assert.equal(text.rows.length, 120); assert.equal(text.reports.length, 0);
  const image = fixture({ text: false, image: true }); await image.provisioner.provision(principal); assert.equal(image.rows.length, 120); assert.equal(image.reports.length, 6);
  assert.ok(image.reports.every(r => r.reasonCode === "NO_APPROVED_DEFAULT" && String(r.resourceKey).endsWith(":TEXT")));
});
test("existing IMAGE assignments are preserved when TEXT defaults are configured later", async () => {
  const f = fixture({ text: false, image: true }); await f.provisioner.provision(principal); const before = structuredClone(f.rows);
  for (const purpose of ONBOARDING_TEMPLATE_PURPOSES) f.add(purpose, "TEXT");
  await f.provisioner.provision(principal); assert.equal(f.rows.length, 240); assert.deepEqual(f.rows.slice(0, 120), before);
});
test("never replaces an existing shop-specific assignment when platform default changes", async () => {
  const f = fixture(); await f.provisioner.provision(principal); const before = structuredClone(f.rows);
  f.add(firstPurpose, "TEXT", "replacement"); await f.provisioner.provision(principal); assert.deepEqual(f.rows, before);
});
test("rejects stale installation credential, stale layout, media-dependent TEXT and wrong format", async () => {
  const stale = fixture(); stale.setCredentialVersion(3); await stale.provisioner.provision(principal); assert.equal(stale.rows.length, 0);
  const layout = fixture({ common: true }); layout.setCommon(commonWrapperFixture("other")); assert.equal(await layout.assign(), "DEFAULT_NOT_APPLICABLE");
  const brand = fixture(); brand.add(firstPurpose, "TEXT", "brand", "shopBrand.brandName"); assert.equal(await brand.assign(), "DEFAULT_NOT_APPLICABLE");
  const format = fixture({ image: true }); format.pointers.set(`${firstPurpose}:TEXT`, format.pointers.get(`${firstPurpose}:IMAGE`)!); assert.equal(await format.assign(), "DEFAULT_NOT_APPLICABLE");
});
test("rejects drifted registration, partial assignments and a changed WABA", async () => {
  const drift = fixture(); const d = drift.definitions.get(drift.pointers.get(`${firstPurpose}:TEXT`)!.definitionId)!; d.locales[0]!.metaRegistrations[0]!.driftDetectedAt = new Date();
  assert.equal(await drift.assign(), "DEFAULT_NOT_APPLICABLE");
  const partial = fixture(); assert.equal(await partial.assign(), "ASSIGNED"); partial.rows.pop(); assert.equal(await partial.assign(), "ASSIGNMENT_REVIEW_REQUIRED");
  const sender = fixture(); sender.setSender("1234567891"); assert.equal(await sender.assign(), "SENDER_CONFIGURATION_UNAVAILABLE");
});
test("a zero provisioning budget starts no work and reports the explicit deferral", async () => {
  const f = fixture(); await f.provisioner.provision(principal, 0); assert.equal(f.rows.length, 0); assert.equal(f.operations.length, 0);
  assert.ok(f.logs.some(l => l.reasonCode === "PROVISIONING_BUDGET_EXHAUSTED"));
});
