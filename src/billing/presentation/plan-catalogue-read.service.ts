import type { Prisma, PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import { BillingPresentationError } from "./billing-read.service.js";

export interface BillingPlanCatalogueResponse {
  schemaVersion: 1;
  resolvedLocale: string;
  plans: Array<{
    merchantPricingPlanId: string;
    displayName: string;
    planKind: "FREE" | "PAID_METERED";
    cataloguePosition: number;
    featured: boolean;
    localizedDescription: string;
    includedRecoveryCredits: number;
    allowancePeriod: "LIFETIME" | "EVERY_30_DAYS";
    billingPeriod: "EVERY_30_DAYS";
    recurringAmountMinor: number;
    currency: string;
    highlights: Array<{ contentKey: string; position: number; title: string; description: string }>;
  }>;
}

export class BillingCatalogueError extends Error {
  constructor(readonly code:
    | "billing_catalogue_invalid"
    | "billing_catalogue_translation_unavailable"
    | "billing_locale_invalid"
  ) {
    super(code);
    this.name = "BillingCatalogueError";
  }
}

type BillingCatalogueDatabase = Pick<PrismaClient, "$transaction">;

export class BillingPlanCatalogueReadService {
  constructor(
    private readonly database: BillingCatalogueDatabase,
    private readonly logger: StructuredLogger,
  ) {}

  async read(
    principal: WooInstallationPrincipal,
    requestedLocale?: string,
  ): Promise<BillingPlanCatalogueResponse> {
    const canonicalRequestedLocale = requestedLocale === undefined
      ? undefined
      : parsePresentationLocale(requestedLocale);
    return this.database.$transaction(
      (transaction) => readCatalogueSnapshot(transaction, principal, canonicalRequestedLocale, this.logger),
      { isolationLevel: "RepeatableRead" },
    );
  }
}

async function readCatalogueSnapshot(
  transaction: Prisma.TransactionClient,
  principal: WooInstallationPrincipal,
  requestedLocale: string | undefined,
  logger: StructuredLogger,
): Promise<BillingPlanCatalogueResponse> {
  const shop = await transaction.shop.findUnique({
    where: { id: principal.shopId },
    select: {
      id: true,
      domain: true,
      platform: true,
      shopifyShopId: true,
      status: true,
      onboardingCompleted: true,
      defaultLanguageTag: true,
    },
  });
  if (
    !shop || shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl ||
    shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null || shop.status !== "ACTIVE"
  ) throw new BillingPresentationError("billing_integrity_invalid");
  if (!shop.onboardingCompleted) throw new BillingPresentationError("billing_not_initialized");

  const plans = await transaction.merchantPricingPlan.findMany({
    where: { isActive: true },
    orderBy: [{ cataloguePosition: "asc" }, { id: "asc" }],
    take: 101,
    select: {
      id: true,
      displayName: true,
      planKind: true,
      cataloguePosition: true,
      featured: true,
      includedRecoveryCredits: true,
      allowancePeriod: true,
      billingPeriod: true,
      recurringAmountMinor: true,
      currency: true,
      translations: { select: { locale: true, merchantDescription: true } },
      highlights: {
        orderBy: [{ position: "asc" }, { contentKey: "asc" }],
        take: 101,
        select: {
          contentKey: true,
          position: true,
          translations: { select: { locale: true, merchantTitle: true, merchantDescription: true } },
        },
      },
    },
  });

  if (plans.length > 100) throw new BillingCatalogueError("billing_catalogue_invalid");

  const freePlans = plans.filter((plan) => plan.planKind === "FREE");
  if (freePlans.length !== 1 || freePlans[0]?.recurringAmountMinor !== 0) {
    throw new BillingCatalogueError("billing_catalogue_invalid");
  }
  const selectable = plans.filter((plan) => {
    if (plan.planKind === "FREE") return true;
    const compatible = plan.planKind === "PAID_METERED" && plan.recurringAmountMinor > 0 &&
      plan.currency === "USD" && plan.billingPeriod === "EVERY_30_DAYS";
    if (!compatible) {
      logger.warn("billing.plans.catalogue_plan_excluded", {
        planId: plan.id,
        reason: "not_woo_v1_selectable",
      });
    }
    return compatible;
  });
  let previousPosition = -1;
  for (const plan of selectable) {
    if (!Number.isSafeInteger(plan.cataloguePosition) || plan.cataloguePosition <= previousPosition) {
      throw new BillingCatalogueError("billing_catalogue_invalid");
    }
    previousPosition = plan.cataloguePosition;
    if (
      !boundedText(plan.id, 128) || !boundedText(plan.displayName, 255) ||
      !Number.isSafeInteger(plan.includedRecoveryCredits) || plan.includedRecoveryCredits < 0 ||
      !Number.isSafeInteger(plan.recurringAmountMinor) || plan.recurringAmountMinor < 0 ||
      !/^[A-Z]{3}$/.test(plan.currency) || typeof plan.featured !== "boolean"
    ) throw new BillingCatalogueError("billing_catalogue_invalid");
    if (plan.planKind === "FREE" && plan.allowancePeriod !== "LIFETIME") {
      throw new BillingCatalogueError("billing_catalogue_invalid");
    }
    if (plan.planKind === "PAID_METERED" && plan.allowancePeriod !== "EVERY_30_DAYS") {
      throw new BillingCatalogueError("billing_catalogue_invalid");
    }
    if (plan.highlights.length > 100) throw new BillingCatalogueError("billing_catalogue_invalid");
    let previousHighlightPosition = -1;
    for (const highlight of plan.highlights) {
      if (!Number.isSafeInteger(highlight.position) || highlight.position <= previousHighlightPosition) {
        throw new BillingCatalogueError("billing_catalogue_invalid");
      }
      previousHighlightPosition = highlight.position;
    }
  }

  const candidates = localeCandidates(requestedLocale, shop.defaultLanguageTag);
  const resolvedLocale = candidates.find((candidate) => selectable.every((plan) =>
    isCompletePlanTranslation(plan, candidate),
  ));
  if (!resolvedLocale) throw new BillingCatalogueError("billing_catalogue_translation_unavailable");

  return {
    schemaVersion: 1,
    resolvedLocale,
    plans: selectable.map((plan) => {
      const translation = exactlyOneTranslation(plan.translations, resolvedLocale);
      if (!translation || !boundedText(translation.merchantDescription, 2000)) {
        throw new BillingCatalogueError("billing_catalogue_translation_unavailable");
      }
      return {
        merchantPricingPlanId: plan.id,
        displayName: plan.displayName,
        planKind: plan.planKind,
        cataloguePosition: plan.cataloguePosition,
        featured: plan.featured,
        localizedDescription: translation.merchantDescription,
        includedRecoveryCredits: plan.includedRecoveryCredits,
        allowancePeriod: plan.allowancePeriod,
        billingPeriod: plan.billingPeriod,
        recurringAmountMinor: plan.recurringAmountMinor,
        currency: plan.currency,
        highlights: plan.highlights.map((highlight) => {
          const localized = exactlyOneTranslation(highlight.translations, resolvedLocale);
          if (
            !boundedText(highlight.contentKey, 128) || !Number.isSafeInteger(highlight.position) ||
            highlight.position < 0 || !localized || !boundedText(localized.merchantTitle, 120) ||
            !boundedText(localized.merchantDescription, 2000)
          ) throw new BillingCatalogueError("billing_catalogue_invalid");
          return {
            contentKey: highlight.contentKey,
            position: highlight.position,
            title: localized.merchantTitle,
            description: localized.merchantDescription,
          };
        }),
      };
    }),
  };
}

function isCompletePlanTranslation(plan: CataloguePlanRow, locale: string): boolean {
  const translation = exactlyOneTranslation(plan.translations, locale);
  return Boolean(
    translation && boundedText(translation.merchantDescription, 2000) &&
    plan.highlights.every((highlight) => {
      const localized = exactlyOneTranslation(highlight.translations, locale);
      return Boolean(localized && boundedText(localized.merchantTitle, 120) &&
        boundedText(localized.merchantDescription, 2000));
    }),
  );
}

export function parsePresentationLocale(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 64) throw new BillingCatalogueError("billing_locale_invalid");
  const trimmed = value.trim();
  try {
    const locale = Intl.getCanonicalLocales(trimmed)[0];
    if (!locale) throw new Error("invalid locale");
    return locale;
  } catch {
    throw new BillingCatalogueError("billing_locale_invalid");
  }
}

function localeCandidates(requestedLocale: string | undefined, defaultLanguageTag: string | null): string[] {
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  const addWithBase = (value: string | undefined) => {
    if (!value) return;
    add(value);
    add(value.split("-")[0]);
  };
  addWithBase(requestedLocale);
  let defaultLocale: string | undefined;
  if (defaultLanguageTag) {
    try {
      defaultLocale = Intl.getCanonicalLocales(defaultLanguageTag)[0];
    } catch {
      defaultLocale = undefined;
    }
  }
  addWithBase(defaultLocale);
  add("en");
  return candidates;
}

function exactlyOneTranslation<T extends { locale: string }>(rows: T[], candidate: string): T | null {
  const matches = rows.filter((row) => normalizeStoredLocale(row.locale) === candidate);
  return matches.length === 1 ? matches[0] ?? null : null;
}

function normalizeStoredLocale(value: string): string | null {
  try {
    return Intl.getCanonicalLocales(value.replaceAll("_", "-"))[0] ?? null;
  } catch {
    return null;
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

type CataloguePlanRow = Prisma.MerchantPricingPlanGetPayload<{
  select: {
    id: true;
    displayName: true;
    planKind: true;
    cataloguePosition: true;
    featured: true;
    includedRecoveryCredits: true;
    allowancePeriod: true;
    billingPeriod: true;
    recurringAmountMinor: true;
    currency: true;
    translations: { select: { locale: true; merchantDescription: true } };
    highlights: {
      orderBy: [{ position: "asc" }, { contentKey: "asc" }];
      select: {
        contentKey: true;
        position: true;
        translations: { select: { locale: true; merchantTitle: true; merchantDescription: true } };
      };
    };
  };
}>;