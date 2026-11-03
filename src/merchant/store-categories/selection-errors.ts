export type CategorySelectionFailureCode =
  | "category_unavailable"
  | "store_category_conflict"
  | "subscription_not_active"
  | "store_category_integrity_invalid";

export class StoreCategorySelectionError extends Error {
  constructor(readonly code: CategorySelectionFailureCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "StoreCategorySelectionError";
  }
}

export const categoryConflict = (options?: ErrorOptions) => new StoreCategorySelectionError("store_category_conflict", options);
