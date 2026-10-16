export class RecoveryCreditPurchaseCommandError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly operationId?: string,
    readonly safeProviderCode?: string,
    readonly purchaseId?: string,
  ) {
    super(code);
    this.name = "RecoveryCreditPurchaseCommandError";
  }
}
