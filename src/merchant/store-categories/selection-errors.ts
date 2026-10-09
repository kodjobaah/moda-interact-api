export type CategorySelectionFailureCode =
  | "category_unavailable"
  | "store_category_conflict"
  | "subscription_not_active"
  | "store_category_integrity_invalid";

export class StoreCategorySelectionError extends Error {
  constructor(readonly code: CategorySelectionFailureCode) {
    super(code);
    this.name = "StoreCategorySelectionError";
  }
}

export const categoryConflict = () => new StoreCategorySelectionError("store_category_conflict");
