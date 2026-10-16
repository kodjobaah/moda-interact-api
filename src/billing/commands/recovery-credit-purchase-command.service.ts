import {
  type PrismaClient,
} from "@prisma/client";
import type { WooInstallationPrincipal } from "../../woocommerce/installation/authenticator.js";
import {
  WooBillingClient,
  type WooChargeRequest,
} from "../../woocommerce/billing/woo-billing-client.js";
import type { WooBillingConfig } from "../../woocommerce/billing/woo-billing-config.js";
import { RecoveryCreditIntentPersistence } from "./recovery-credit-intent.js";
import {
  RecoveryCreditOutcomePersistence,
  operationResponse,
  replayOperation,
} from "./recovery-credit-outcome.js";
import {
  createWooReturnUrl,
  formatUsdMinorUnits,
} from "./recurring-command-primitives.js";

export type RecoveryCreditPurchaseCommandResponse = {
  schemaVersion: 1;
  purchaseId: string;
  operationId: string;
  state: "AWAITING_CONFIRMATION" | "CONFIRMED";
  confirmationUrl: string;
};

export { RecoveryCreditPurchaseCommandError } from "./recovery-credit-command-error.js";

type BillingDatabase = Pick<PrismaClient, "$transaction">;
type ProviderClient = Pick<WooBillingClient, "createCharge">;

export class RecoveryCreditPurchaseCommandService {
  constructor(
    database: BillingDatabase,
    private readonly provider: ProviderClient,
    providerEnvironment: WooBillingConfig["environment"],
  ) {
    this.intentPersistence = new RecoveryCreditIntentPersistence(database);
    this.outcomePersistence = new RecoveryCreditOutcomePersistence(database, providerEnvironment);
  }

  private readonly intentPersistence: RecoveryCreditIntentPersistence;
  private readonly outcomePersistence: RecoveryCreditOutcomePersistence;

  async initiate(
    principal: WooInstallationPrincipal,
    requestKey: string,
    merchantPricingUsageEventId: string,
  ): Promise<RecoveryCreditPurchaseCommandResponse> {
    const intent = await this.intentPersistence.persistIntent(principal, requestKey, merchantPricingUsageEventId);
    if (intent.replay) return replayOperation(intent.operation);

    const operation = intent.operation;
    let evidence: { id: string; confirmationUrl: string };
    try {
      const body: WooChargeRequest = {
        name: intent.bundleLabel,
        price: formatUsdMinorUnits(operation.quotedAmountMinor!),
        return_url: createWooReturnUrl(intent.canonicalSiteUrl, operation.id),
      };
      evidence = this.outcomePersistence.validateChargeResponse(
        await this.provider.createCharge(body),
      );
    } catch (error) {
      const outcome = await this.outcomePersistence.failProviderOperation(operation, error);
      return operationResponse(outcome);
    }

    return operationResponse(await this.outcomePersistence.confirmProviderOperation(operation, evidence));
  }
}
