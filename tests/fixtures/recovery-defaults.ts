import { createHash } from "node:crypto";
import { MODA_SUPPORTED_LANGUAGE_TAGS } from "@modainteract/moda-interact-shared/internationalization";
import { templateEvidenceHash } from "../../src/merchant/recovery-templates/default-source.js";
import { providerComponentsHash } from "../../src/merchant/recovery-templates/provider-hash.js";
import type { OnboardingTemplatePurpose } from "../../src/merchant/recovery-templates/publication.js";

export const WABA = "1234567890";
export const ADMIN_ID = "recovery-default-fixture-admin";
export const languages = [...MODA_SUPPORTED_LANGUAGE_TAGS];
const reviewedAt = new Date("2026-11-14T10:00:00Z");
const code = (tag: string) =>
  tag === "zh-Hans"
    ? "zh_CN"
    : tag === "zh-Hant"
      ? "zh_TW"
      : tag.replace("-", "_");
const definitionId = (value: string) =>
  `wtdef_${createHash("sha256").update(value).digest("hex")}`;

export function commonWrapperFixture(revision = "one") {
  const id = definitionId(`common-${revision}`);
  const authoring = {
    schemaVersion: 1,
    family: "MODA_CONVERSATION_WRAPPER",
    audience: "SHARED",
    sourceLanguageTag: "en",
    header: [{ type: "variable", name: "shop.name" }],
    body: [{ type: "slot", name: "response.body" }],
    footer: [],
    conditionals: [
      {
        when: "checkout.available",
        nodes: [
          { type: "variable", name: "shop.websiteUrl" },
          { type: "text", value: "\n" },
          { type: "variable", name: "checkout.url" },
        ],
      },
    ],
  };
  const prepared = {
    schemaVersion: 1,
    family: "MODA_CONVERSATION_WRAPPER",
    header: [{ kind: "variable", name: "shop.name" }],
    body: [{ kind: "responseSlot", name: "response.body" }],
    responseSlot: "response.body",
    footer: [],
    conditionals: [
      {
        when: "checkout.available",
        tokens: [
          { kind: "variable", name: "shop.websiteUrl" },
          { kind: "text", value: "\n" },
          { kind: "variable", name: "checkout.url" },
        ],
      },
    ],
  };
  return {
    id,
    kind: "MODA_CONVERSATION_WRAPPER",
    audience: "SHARED",
    sourceHash: templateEvidenceHash(authoring),
    sourceLanguageTag: "en",
    astSchemaVersion: 1,
    status: "PUBLISHED",
    retiredAt: null,
    publishedAt: reviewedAt,
    locales: languages.map((languageTag) => ({
      id: `${id}-${languageTag}`,
      languageTag,
      providerLanguageCode: null,
      status: languageTag === "en" ? "SOURCE_SAVED" : "REVIEWED",
      reviewedAt,
      reviewedByAdminId: ADMIN_ID,
      contentHash: templateEvidenceHash(prepared),
      localeAst: { schemaVersion: 1, authoring, prepared },
    })),
  };
}

type Wrapper = ReturnType<typeof commonWrapperFixture>;

/** Mirrors the saved Admin v1 locale and frozen TEXT registration shapes.
 * The integration tests seed them directly: no Admin or live Meta call. */
export function recoveryDefaultFixture(
  purpose: OnboardingTemplatePurpose,
  revision = "one",
  common?: Wrapper,
  image = false,
  bodyVariable = "shop.name",
) {
  const stage = purpose.startsWith("INITIAL_") ? "INITIAL" : "FOLLOW_UP";
  const offerType = purpose.slice(stage.length + 1);
  const id = definitionId(`${purpose}-${revision}`);
  const providerTemplateName = `moda_${purpose.toLowerCase()}_${id.slice(-20)}`;
  const authoringFor = (languageTag: string) => {
    const saved = common?.locales.find(
      (locale) => locale.languageTag === languageTag,
    );
    return {
      schemaVersion: 1,
      family: "META_RECOVERY",
      sourceLanguageTag: "en",
      stage,
      offerType,
      ...(offerType === "NO_OFFER" ? {} : { promotionTarget: "CHECKOUT" }),
      ...(image ? { shopBrandMediaRole: "LOGO" } : {}),
      ...(common && saved
        ? {
            commonLayout: {
              schemaVersion: 1,
              definitionId: common.id,
              sourceHash: common.sourceHash,
              localeId: saved.id,
              languageTag,
              contentHash: saved.contentHash,
              prepared: saved.localeAst.prepared,
            },
          }
        : {}),
      header: [],
      body: [
        { type: "text", value: "Your basket at " },
        { type: "variable", name: bodyVariable },
        { type: "text", value: " is waiting. Reply to this message for help." },
      ],
      footer: [],
      buttons: [],
    };
  };
  const sourceHash = templateEvidenceHash(authoringFor("en"));
  const locales = languages.map((languageTag, index) => {
    const authoring = authoringFor(languageTag);
    const prepared = {
      schemaVersion: 1,
      family: "META_RECOVERY",
      category: "MARKETING",
      components: [
        ...(image ? [{ type: "HEADER", format: "IMAGE" }] : []),
        {
          type: "BODY",
          text: "Your basket at {{1}} is waiting. Reply to this message for help.",
          example: { body_text: [["Example shop"]] },
        },
      ],
      parameterBindings: {
        ...(image ? { schemaVersion: 1, headerMediaRole: "LOGO" } : {}),
        ...(offerType === "NO_OFFER" ? {} : { promotionTarget: "CHECKOUT" }),
        header: [],
        body: [{ position: 1, variable: bodyVariable }],
        buttons: [],
      },
    };
    const contentHash = templateEvidenceHash(prepared);
    const localeId = `${id}-${languageTag}`;
    return {
      id: localeId,
      definitionId: id,
      languageTag,
      providerLanguageCode: code(languageTag),
      status: "REVIEWED",
      reviewedAt,
      reviewedByAdminId: ADMIN_ID,
      contentHash,
      localeAst: { schemaVersion: 1, authoring, prepared },
      metaRegistrations: [
        {
          id: `${localeId}-registration`,
          localeId,
          wabaId: WABA,
          providerTemplateName,
          providerLanguageCode: code(languageTag),
          providerTemplateId: `${BigInt(`0x${id.slice(-12)}`)}${String(index).padStart(2, "0")}`,
          providerStatus: "APPROVED",
          submissionState: "SUBMITTED",
          lastReconciledAt: reviewedAt,
          category: "MARKETING",
          lastObservedCategory: "MARKETING",
          failureCode: null as string | null,
          driftDetectedAt: null as Date | null,
          lastObservedContentHash: providerComponentsHash(prepared.components),
          submittedContentHash: contentHash,
          componentsSnapshot: structuredClone(prepared.components),
          parameterBindingsSnapshot: image
            ? structuredClone(prepared.parameterBindings)
            : {
                ...structuredClone(prepared.parameterBindings),
                schemaVersion: 1,
                sourceHash,
                localeContentHash: contentHash,
              },
        },
      ],
    };
  });
  return {
    id,
    kind: "META_RECOVERY",
    purpose: stage,
    offerType,
    category: "MARKETING",
    providerTemplateName,
    sourceLanguageTag: "en",
    sourceHash,
    astSchemaVersion: 1,
    status: "PUBLISHED",
    retiredAt: null as Date | null,
    publishedAt: reviewedAt,
    locales,
  };
}
