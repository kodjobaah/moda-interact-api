import assert from "node:assert/strict";
import test from "node:test";
import { RecurringSubscriptionCommandService } from "../../../../src/billing/commands/recurring-subscription-command.service.js";
import { RecoveryCreditPurchaseCommandService } from "../../../../src/billing/commands/recovery-credit-purchase-command.service.js";
import { RecurringBillingCommandError } from "../../../../src/billing/commands/recurring-command-error.js";
import { RecoveryCreditPurchaseCommandError } from "../../../../src/billing/commands/recovery-credit-command-error.js";

// A rejected preflight must not materialize any billing intent (or even start a DB transaction).
test("new recurring and one-time commands fail before persistence when sealed credentials are unavailable", async () => {
  let resolutions = 0;
  let transactions = 0;
  const database = { async $transaction() { transactions++; throw Error("not called"); } };
  const missing = async () => { resolutions++; throw Error("private-credential-value"); };
  const recurring = new RecurringSubscriptionCommandService(database as never, missing, "sandbox");
  const oneTime = new RecoveryCreditPurchaseCommandService(database as never, missing, "sandbox");
  for (const command of [
    () => recurring.create({} as never, "key", "plan"),
    () => recurring.switchPlan({} as never, "key", "plan"),
    () => recurring.cancel({} as never, "key"),
  ]) {
    await assert.rejects(command(), (error: unknown) => error instanceof RecurringBillingCommandError &&
      error.statusCode === 503 && error.code === "billing_provider_unavailable" &&
      !error.message.includes("private-credential-value"));
  }
  await assert.rejects(oneTime.initiate({} as never, "key", "usage"), (error: unknown) =>
    error instanceof RecoveryCreditPurchaseCommandError && error.statusCode === 503 &&
    error.code === "billing_provider_unavailable" && !error.message.includes("private-credential-value"));
  assert.equal(resolutions, 4);
  assert.equal(transactions, 0);
});
