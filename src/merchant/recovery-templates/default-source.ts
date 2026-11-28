import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { MODA_SUPPORTED_LANGUAGE_TAGS } from "@modainteract/moda-interact-shared/internationalization";
import { providerComponentsHash } from "./provider-hash.js";
import {
  recoveryHeaderKind,
  recoveryTemplateFormat,
  isBrandIndependentText,
  validImageRole,
  type RecoveryTemplateFormat,
  type RecoveryHeaderKind,
} from "./format.js";

export const LANGUAGES: readonly string[] = MODA_SUPPORTED_LANGUAGE_TAGS;
const DIGEST = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Match the Admin immutable authoring digest (not the provider observation hash).
 * The consumer verifies saved bytes; Admin remains the only authoring/compiler owner. */
export function stableTemplateJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableTemplateJson).join(",")}]`;
  if (record(value))
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(
        ([key, child]) => `${JSON.stringify(key)}:${stableTemplateJson(child)}`,
      )
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Non-JSON template evidence");
  return encoded;
}
export const templateEvidenceHash = (value: unknown): string =>
  createHash("sha256").update(stableTemplateJson(value), "utf8").digest("hex");
const same = (a: unknown, b: unknown) =>
  stableTemplateJson(a) === stableTemplateJson(b);
const hashMatches = (value: unknown, hash: string | null): boolean =>
  Boolean(hash && DIGEST.test(hash) && templateEvidenceHash(value) === hash);

function providerCode(tag: string): string {
  if (tag === "zh-Hans") return "zh_CN";
  if (tag === "zh-Hant") return "zh_TW";
  return tag.replace("-", "_");
}

const definitionSelect = {
  id: true,
  kind: true,
  purpose: true,
  offerType: true,
  status: true,
  providerTemplateName: true,
  publishedAt: true,
  retiredAt: true,
  category: true,
  astSchemaVersion: true,
  sourceLanguageTag: true,
  sourceHash: true,
  locales: {
    select: {
      id: true,
      definitionId: true,
      status: true,
      languageTag: true,
      providerLanguageCode: true,
      localeAst: true,
      contentHash: true,
      reviewedAt: true,
      reviewedByAdminId: true,
      metaRegistrations: {
        select: {
          id: true,
          localeId: true,
          wabaId: true,
          providerTemplateName: true,
          providerLanguageCode: true,
          providerTemplateId: true,
          providerStatus: true,
          submissionState: true,
          lastReconciledAt: true,
          failureCode: true,
          driftDetectedAt: true,
          category: true,
          lastObservedCategory: true,
          lastObservedContentHash: true,
          submittedContentHash: true,
          componentsSnapshot: true,
          parameterBindingsSnapshot: true,
        },
      },
    },
  },
} as const satisfies Prisma.WhatsAppTemplateDefinitionSelect;
type SourceDefinition = Prisma.WhatsAppTemplateDefinitionGetPayload<{
  select: typeof definitionSelect;
}>;
type SourceLocale = SourceDefinition["locales"][number];
type Registration = SourceLocale["metaRegistrations"][number];

/** Recheck provider reconciliation, review and exact frozen registration evidence.
 * The selected default is trusted Admin configuration, not an arbitrary saved version. */
function approvedRegistration(
  def: SourceDefinition,
  locale: SourceLocale,
  wabaId: string,
): Registration | null {
  const matching = locale.metaRegistrations.filter(
    (reg) => reg.wabaId === wabaId,
  );
  const reg = matching[0];
  const ast = locale.localeAst;
  if (
    matching.length !== 1 ||
    !reg ||
    locale.definitionId !== def.id ||
    locale.status !== "REVIEWED" ||
    (locale.languageTag !== "en" &&
      (!locale.reviewedAt || !locale.reviewedByAdminId)) ||
    locale.providerLanguageCode !== providerCode(locale.languageTag) ||
    !record(ast) ||
    ast.schemaVersion !== 1 ||
    !record(ast.authoring) ||
    !record(ast.prepared)
  )
    return null;
  const authoring = ast.authoring;
  const prepared = ast.prepared;
  const bindings = prepared.parameterBindings;
  if (
    authoring.schemaVersion !== 1 ||
    authoring.family !== "META_RECOVERY" ||
    authoring.stage !== def.purpose ||
    authoring.offerType !== def.offerType ||
    authoring.sourceLanguageTag !== "en" ||
    (locale.languageTag === "en" && !hashMatches(authoring, def.sourceHash)) ||
    authoring.promotionTarget === "ALTERNATIVE_PRODUCT" ||
    prepared.schemaVersion !== 1 ||
    prepared.family !== "META_RECOVERY" ||
    prepared.category !== "MARKETING" ||
    !Array.isArray(prepared.components) ||
    !record(bindings) ||
    (bindings.headerMediaRole
      ? bindings.schemaVersion !== 1
      : bindings.schemaVersion !== undefined && bindings.schemaVersion !== 1) ||
    !Array.isArray(bindings.body) ||
    !Array.isArray(bindings.buttons) ||
    (bindings.header !== undefined && !Array.isArray(bindings.header)) ||
    (bindings.promotionTarget !== undefined &&
      bindings.promotionTarget !== "CHECKOUT") ||
    (authoring.promotionTarget !== undefined &&
      authoring.promotionTarget !== bindings.promotionTarget) ||
    (def.offerType === "NO_OFFER" && bindings.promotionTarget !== undefined) ||
    !hashMatches(prepared, locale.contentHash)
  )
    return null;
  // Admin stores the exact IMAGE bindings and the historical enriched TEXT binding shape.
  const expectedBindings = bindings.headerMediaRole
    ? bindings
    : {
        schemaVersion: 1,
        sourceHash: def.sourceHash,
        localeContentHash: locale.contentHash,
        ...(bindings.promotionTarget
          ? { promotionTarget: bindings.promotionTarget }
          : {}),
        header: bindings.header ?? [],
        body: bindings.body,
        buttons: bindings.buttons,
      };
  if (
    reg.localeId !== locale.id ||
    reg.providerTemplateName !== def.providerTemplateName ||
    reg.providerLanguageCode !== locale.providerLanguageCode ||
    !reg.providerTemplateId ||
    reg.providerStatus !== "APPROVED" ||
    reg.submissionState !== "SUBMITTED" ||
    reg.category !== "MARKETING" ||
    reg.failureCode ||
    reg.driftDetectedAt ||
    reg.lastObservedCategory !== "MARKETING" ||
    !reg.lastReconciledAt ||
    !Number.isFinite(reg.lastReconciledAt.getTime()) ||
    reg.submittedContentHash !== locale.contentHash ||
    !same(reg.componentsSnapshot, prepared.components) ||
    !same(reg.parameterBindingsSnapshot, expectedBindings) ||
    reg.lastObservedContentHash !==
      providerComponentsHash(reg.componentsSnapshot)
  )
    return null;
  return reg;
}

/** Global common-activation advisory lock is already held by the caller. Match
 * all saved references to the active SHARED wrapper revision and exact locale
 * bytes; never recompile Admin content or adopt an inactive layout. */
async function currentCommonLayout(
  tx: Prisma.TransactionClient,
  locales: SourceLocale[],
): Promise<boolean> {
  const slot = await tx.whatsAppConversationWrapperActiveSlot.findUnique({
    where: { audience: "SHARED" },
    select: {
      definitionId: true,
      definition: {
        select: {
          id: true,
          kind: true,
          audience: true,
          status: true,
          sourceHash: true,
          sourceLanguageTag: true,
          publishedAt: true,
          retiredAt: true,
          astSchemaVersion: true,
          locales: {
            select: {
              id: true,
              languageTag: true,
              providerLanguageCode: true,
              status: true,
              reviewedAt: true,
              reviewedByAdminId: true,
              contentHash: true,
              localeAst: true,
            },
          },
        },
      },
    },
  });
  const refs = locales.map((locale) => {
    const ast = locale.localeAst;
    return record(ast) && record(ast.authoring)
      ? ast.authoring.commonLayout
      : undefined;
  });
  if (!slot) return refs.every((ref) => ref === undefined);
  const wrapper = slot.definition;
  if (
    wrapper.id !== slot.definitionId ||
    wrapper.kind !== "MODA_CONVERSATION_WRAPPER" ||
    wrapper.audience !== "SHARED" ||
    wrapper.status !== "PUBLISHED" ||
    !wrapper.publishedAt ||
    wrapper.retiredAt ||
    wrapper.sourceLanguageTag !== "en" ||
    wrapper.astSchemaVersion !== 1 ||
    !DIGEST.test(wrapper.sourceHash) ||
    wrapper.locales.length !== LANGUAGES.length
  )
    return false;
  return locales.every((locale, index) => {
    const ref = refs[index];
    const saved = wrapper.locales.find(
      (item) => item.languageTag === locale.languageTag,
    );
    const ast = saved?.localeAst;
    const english = locale.languageTag === "en";
    return Boolean(
      record(ref) &&
      saved &&
      record(ast) &&
      ast.schemaVersion === 1 &&
      record(ast.authoring) &&
      record(ast.prepared) &&
      ref.schemaVersion === 1 &&
      ref.definitionId === wrapper.id &&
      ref.sourceHash === wrapper.sourceHash &&
      ref.localeId === saved.id &&
      ref.languageTag === locale.languageTag &&
      ref.contentHash === saved.contentHash &&
      saved.providerLanguageCode === null &&
      saved.status === (english ? "SOURCE_SAVED" : "REVIEWED") &&
      (english
        ? hashMatches(ast.authoring, wrapper.sourceHash)
        : Boolean(saved.reviewedAt && saved.reviewedByAdminId)) &&
      locale.reviewedAt &&
      locale.reviewedByAdminId &&
      hashMatches(ast.prepared, saved.contentHash) &&
      record(ref.prepared) &&
      same(ref.prepared, ast.prepared),
    );
  });
}

export type VerifiedDefault = {
  definitionId: string;
  registrations: Registration[];
  registrationIds: Record<string, string>;
  evidenceFingerprint: string;
};

export async function readVerifiedDefault(
  tx: Prisma.TransactionClient,
  definitionId: string,
  purpose: string,
  wabaId: string,
  format: RecoveryTemplateFormat,
): Promise<VerifiedDefault | null> {
  // Coordinate with Admin's default setter and registration reconciliation.
  // Read only after taking the exact source locks in the Admin order.
  await tx.$queryRaw`SELECT "id" FROM "whatsapp"."WhatsAppTemplateDefinition" WHERE "id"=${definitionId} FOR UPDATE`;
  const locales = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT "id" FROM "whatsapp"."WhatsAppTemplateLocale"
    WHERE "definitionId"=${definitionId} ORDER BY "id" LIMIT 21 FOR UPDATE`;
  if (locales.length !== LANGUAGES.length) return null;
  const registrations = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT r."id" FROM "whatsapp"."WhatsAppTemplateMetaRegistration" r
    JOIN "whatsapp"."WhatsAppTemplateLocale" l ON l."id"=r."localeId"
    WHERE l."definitionId"=${definitionId} AND r."wabaId"=${wabaId} ORDER BY r."id" LIMIT 21 FOR UPDATE OF r`;
  if (registrations.length !== LANGUAGES.length) return null;
  const definition = await tx.whatsAppTemplateDefinition.findUnique({
    where: { id: definitionId },
    select: {
      ...definitionSelect,
      locales: {
        select: {
          ...definitionSelect.locales.select,
          metaRegistrations: {
            where: { wabaId },
            select: definitionSelect.locales.select.metaRegistrations.select,
          },
        },
      },
    },
  });
  if (
    !definition ||
    definition.id !== definitionId ||
    definition.kind !== "META_RECOVERY" ||
    definition.status !== "PUBLISHED" ||
    !definition.publishedAt ||
    definition.retiredAt ||
    definition.category !== "MARKETING" ||
    !definition.providerTemplateName ||
    definition.astSchemaVersion !== 1 ||
    definition.sourceLanguageTag !== "en" ||
    !DIGEST.test(definition.sourceHash) ||
    `${definition.purpose}_${definition.offerType}` !== purpose ||
    definition.locales.length !== LANGUAGES.length
  )
    return null;
  const verified: Registration[] = [];
  const orderedLocales: SourceLocale[] = [];
  let headerKind: RecoveryHeaderKind | null = null;
  let imageRole: string | null = null;
  for (const language of LANGUAGES) {
    const matches = definition.locales.filter(
      (locale) => locale.languageTag === language,
    );
    if (matches.length !== 1) return null;
    const locale = matches[0]!;
    const reg = approvedRegistration(definition, locale, wabaId);
    if (
      !reg ||
      !registrations.some((row) => row.id === reg.id) ||
      !locales.some((row) => row.id === locale.id)
    )
      return null;
    const kind = recoveryHeaderKind(reg.componentsSnapshot);
    if (
      !kind ||
      recoveryTemplateFormat(reg.componentsSnapshot) !== format ||
      (headerKind !== null && headerKind !== kind)
    )
      return null;
    headerKind = kind;
    if (format === "TEXT") {
      if (!isBrandIndependentText(reg.parameterBindingsSnapshot)) return null;
    } else {
      const role = validImageRole(reg.parameterBindingsSnapshot);
      if (!role || (imageRole !== null && imageRole !== role)) return null;
      imageRole = role;
    }
    verified.push(reg);
    orderedLocales.push(locale);
  }
  if (
    new Set(verified.map((reg) => reg.id)).size !== LANGUAGES.length ||
    new Set(verified.map((reg) => reg.providerTemplateId)).size !==
      LANGUAGES.length ||
    !(await currentCommonLayout(tx, orderedLocales))
  )
    return null;
  return {
    definitionId,
    registrations: verified,
    registrationIds: Object.fromEntries(
      orderedLocales.map((locale, i) => [locale.languageTag, verified[i]!.id]),
    ),
    evidenceFingerprint: templateEvidenceHash([
      definitionId,
      purpose,
      wabaId,
      format,
      definition.sourceHash,
      orderedLocales.map((locale, i) => [
        locale.languageTag,
        locale.contentHash,
        verified[i]!.id,
        verified[i]!.providerTemplateId,
        verified[i]!.lastObservedContentHash,
      ]),
    ]),
  };
}
