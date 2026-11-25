import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createOperationalIncidentReporter, createPrismaOperationalIncidentPersistence,
  OPERATIONAL_INCIDENT_CONTRACT_VERSION,
} from "@modainteract/moda-interact-shared/incidents";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import type { TransactionMessagingSenderFactory } from "../../platform-configuration/composition.js";
import { RECOVERY_TEMPLATE_FORMATS, type RecoveryTemplateFormat } from "./format.js";
import { assignOnePurpose, ONBOARDING_TEMPLATE_PURPOSES } from "./publication.js";

type Reporter = Pick<ReturnType<typeof createOperationalIncidentReporter>, "report">;
type Options = {
  database: Pick<PrismaClient, "$transaction">;
  environment: string;
  sender: TransactionMessagingSenderFactory;
  logger: Pick<StructuredLogger, "info" | "warn" | "error">;
  /** Test seam: production uses the canonical incident writer. */
  reporter?: Reporter;
  now?: () => number;
};
const SUCCESS = new Set(["ASSIGNED", "ALREADY_ASSIGNED", "OPTIONAL_IMAGE_NOT_CONFIGURED"]);
const MAX_PROVISIONING_MS = 8_000;
const MIN_TRANSACTION_BUDGET_MS = 100;

class ProvisioningBudgetExhausted extends Error {
  constructor() { super("recovery_template_provisioning_budget_exhausted"); }
}

/** The connection's committed credential must not depend on this work. A
 * reconnect retries missing slots; Admin can also publish directly. This is
 * bounded synchronous post-commit work, not a durable background job. */
export class WooRecoveryTemplateProvisioner {
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.now());
  }

  async provision(principal: WooInstallationPrincipal, budgetMs = MAX_PROVISIONING_MS): Promise<void> {
    const { database, logger, environment, sender } = this.options;
    const deadline = this.now() + (Number.isFinite(budgetMs) ? Math.max(0, Math.min(budgetMs, MAX_PROVISIONING_MS)) : 0);
    const shopId = principal.shopId;
    const transaction = async <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
      const remaining = Math.floor(deadline - this.now());
      if (remaining < MIN_TRANSACTION_BUDGET_MS) throw new ProvisioningBudgetExhausted();
      const maxWait = Math.min(300, Math.floor(remaining / 4));
      return database.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait, timeout: Math.min(2_000, remaining - maxWait) });
    };
    // Cap incident transactions against the same request budget. The canonical
    // incident writer owns deduplication and immutable event history.
    const reporter = this.options.reporter ?? createOperationalIncidentReporter({
      persistence: createPrismaOperationalIncidentPersistence({
        prisma: { $transaction: callback => transaction(tx => callback(tx)) }, maxAttempts: 1,
      }), logger,
    });
    const report = async (purpose: string, reasonCode: string, format?: RecoveryTemplateFormat, error?: unknown) => {
      const fields = { shopId, purpose, format, reasonCode };
      if (error !== undefined) logger.error("woocommerce.onboarding.template_assignment.failed", { ...fields, error,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error) });
      else logger.warn("woocommerce.onboarding.template_assignment.unavailable", fields);
      if (deadline - this.now() < MIN_TRANSACTION_BUDGET_MS) {
        logger.warn("woocommerce.onboarding.template_assignment.incident_deferred", fields);
        return;
      }
      const resourceKey = format ? `${shopId}:${purpose}:${format}` : `${shopId}:${purpose}`;
      try {
        const result = await reporter.report({ contractVersion: OPERATIONAL_INCIDENT_CONTRACT_VERSION,
          sourceService: "moda-interact-api", environment, category: "WHATSAPP_TEMPLATE_PROVISIONING",
          reasonCode, resourceKey, shopId, severity: "HIGH", occurrenceId: randomUUID(), correlationId: resourceKey,
          occurredAt: new Date().toISOString(),
          errorMessage: `WooCommerce recovery ${purpose}${format ? ` ${format}` : ""}: ${reasonCode}. Verify the configured WABA, approved platform default and shop assignments in Admin; resolve the issue and retry connection or publish directly.`,
        });
        if (!result) logger.error("woocommerce.onboarding.template_assignment.incident_failed", fields);
      } catch (incidentError) {
        logger.error("woocommerce.onboarding.template_assignment.incident_failed", { ...fields, error: incidentError,
          errorName: incidentError instanceof Error ? incidentError.name : typeof incidentError,
          errorMessage: incidentError instanceof Error ? incidentError.message : String(incidentError) });
      }
    };
    const readSenderWaba = (tx: Prisma.TransactionClient) => sender(tx).readMessagingSenderWabaId();
    let wabaId: string;
    try {
      wabaId = await transaction(readSenderWaba);
      if (!/^\d{4,32}$/.test(wabaId)) throw new Error("invalid_recovery_sender_waba");
    } catch (error) {
      await report("SENDER", error instanceof ProvisioningBudgetExhausted ? "PROVISIONING_BUDGET_EXHAUSTED" : "SENDER_CONFIGURATION_UNAVAILABLE", undefined, error);
      return;
    }
    // Required baseline first, then optional enhancements. Each purpose/format
    // commits independently. Never continue a stale/revoked installation.
    for (const format of RECOVERY_TEMPLATE_FORMATS) for (const purpose of ONBOARDING_TEMPLATE_PURPOSES) {
      if (deadline - this.now() < MIN_TRANSACTION_BUDGET_MS) {
        await report(purpose, "PROVISIONING_BUDGET_EXHAUSTED", format);
        return;
      }
      try {
        const outcome = await transaction(tx => assignOnePurpose(tx, principal, purpose, wabaId, format,
          { environment, readSenderWaba }));
        logger.info("woocommerce.onboarding.template_assignment.outcome", { shopId, purpose, format, outcome });
        if (outcome === "SHOP_INELIGIBLE") return;
        if (!SUCCESS.has(outcome)) await report(purpose, outcome, format);
        if (outcome === "SENDER_CONFIGURATION_UNAVAILABLE") return;
      } catch (error) {
        await report(purpose, error instanceof ProvisioningBudgetExhausted ? "PROVISIONING_BUDGET_EXHAUSTED" : "ASSIGNMENT_TRANSACTION_FAILED", format, error);
        if (error instanceof ProvisioningBudgetExhausted) return;
      }
    }
  }
}
