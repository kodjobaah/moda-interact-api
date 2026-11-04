export class RecoveryCreditPurchaseCommandError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly operationId?: string,
    readonly safeProviderCode?: string,
    readonly purchaseId?: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "RecoveryCreditPurchaseCommandError";
  }
}
