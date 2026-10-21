import { type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { InitialWooFreeActivationService } from "../../woocommerce/billing/initial-free-activation.service.js";
import { WooBillingClient, type WooSubscriptionRequest } from "../../woocommerce/billing/woo-billing-client.js";
import type { WooBillingConfig } from "../../woocommerce/billing/woo-billing-config.js";
import { createWooReturnUrl, formatUsdMinorUnits, type RecurringOperationKind } from "./recurring-command-primitives.js";
import { RecurringIntentPersistence, type MaterializedPlanResolver } from "./recurring-intent.js";
import { RecurringOutcomePersistence, type RecurringCommandResponse } from "./recurring-outcome.js";

// Preserve existing public imports for API routes and other consumers.
import { RecurringBillingCommandError } from "./recurring-command-error.js";
export { RecurringBillingCommandError } from "./recurring-command-error.js";
export type { RecurringCommandResponse } from "./recurring-outcome.js";

type BillingDatabase = Pick<PrismaClient, "$transaction">;
type ProviderClient = Pick<WooBillingClient, "createSubscription" | "switchSubscription" | "cancelSubscription">;
type ProviderSource = ProviderClient | (() => Promise<ProviderClient>);

export class RecurringSubscriptionCommandService {
  private readonly intentPersistence: RecurringIntentPersistence;
  private readonly outcomePersistence: RecurringOutcomePersistence;

  constructor(
    database: BillingDatabase,
    private readonly provider: ProviderSource,
    providerEnvironment: WooBillingConfig["environment"],
    planResolver: MaterializedPlanResolver = new InitialWooFreeActivationService(),
  ) {
    this.intentPersistence = new RecurringIntentPersistence(database, planResolver);
    this.outcomePersistence = new RecurringOutcomePersistence(database, providerEnvironment);
  }

  async create(
    principal: WooInstallationPrincipal,
    requestKey: string,
    merchantPricingPlanId: string,
  ): Promise<RecurringCommandResponse> {
    return this.execute(principal, "SUBSCRIPTION_CREATE", requestKey, merchantPricingPlanId);
  }

  async switchPlan(
    principal: WooInstallationPrincipal,
    requestKey: string,
    merchantPricingPlanId: string,
  ): Promise<RecurringCommandResponse> {
    return this.execute(principal, "PLAN_SWITCH", requestKey, merchantPricingPlanId);
  }

  async cancel(principal: WooInstallationPrincipal, requestKey: string): Promise<RecurringCommandResponse> {
    return this.execute(principal, "CANCEL", requestKey);
  }

  private async execute(
    principal: WooInstallationPrincipal,
    kind: RecurringOperationKind,
    requestKey: string,
    merchantPricingPlanId?: string,
  ): Promise<RecurringCommandResponse> {
    let provider: ProviderClient;
    try {
      provider = typeof this.provider === "function" ? await this.provider() : this.provider;
    } catch {
      // Failure occurs before an intent is persisted or any provider request is made.
      throw new RecurringBillingCommandError(503, "billing_provider_unavailable");
    }
    const intent = await this.intentPersistence.persistIntent(principal, kind, requestKey, merchantPricingPlanId);
    if (intent.replay) return this.outcomePersistence.replayOperation(intent.operation);

    if (kind === "CANCEL") {
      try {
        await provider.cancelSubscription(intent.operation.providerReference!);
      } catch (error) {
        return this.outcomePersistence.failProviderOperation(intent.operation.id, error);
      }
      return this.outcomePersistence.confirmCancellation(intent.operation.id);
    }

    let evidence: { id: string; confirmationUrl: string };
    try {
      const body: WooSubscriptionRequest = {
        name: intent.targetPlan!.displayName,
        price: formatUsdMinorUnits(intent.operation.quotedAmountMinor!),
        billing_period: "month",
        billing_interval: 1,
        return_url: createWooReturnUrl(intent.canonicalSiteUrl, intent.operation.id),
      };
      const response = kind === "SUBSCRIPTION_CREATE"
        ? await provider.createSubscription(body)
        : await provider.switchSubscription(intent.operation.providerReference!, body);
      evidence = this.outcomePersistence.validateSubscriptionEvidence(response, kind, intent.operation.providerReference);
    } catch (error) {
      return this.outcomePersistence.failProviderOperation(intent.operation.id, error);
    }
    return this.outcomePersistence.confirmSubscription(intent.operation, evidence);
  }
}
