export class RecurringBillingCommandError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly operationId?: string,
    readonly safeProviderCode?: string,
  ) {
    super(code);
    this.name = "RecurringBillingCommandError";
  }
}
