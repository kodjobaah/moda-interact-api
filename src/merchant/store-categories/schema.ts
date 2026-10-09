/** Versioned API-005 merchant read contract. Never contains prompt text or customer data. */
export interface CategoryIdentity {
  id: string;
  slug: string;
  localizedDisplayName: string;
  localizedDescription: string;
}

export interface StoreCategoryChoice extends CategoryIdentity {
  mappings: Array<{ id: string; conditionKey: string; localizedDisplayName: string }>;
  defaultTemplate: { id: string; key: string; displayName: string; editVersion: number };
}

export interface StoreCategoryProfile {
  activeCategory: CategoryIdentity | null;
  pendingCategory: CategoryIdentity | null;
  pendingSelectionGeneration: number;
  pendingSelectedAt: string | null;
  activeMappingIds: string[];
  pendingMappingIds: string[];
  pendingState: "NONE" | "PENDING_PUBLICATION";
  pendingTemplate: {
    id: string;
    key: string;
    displayName: string;
    editVersion: number | null;
  } | null;
}

export interface StoreCategoriesReadResponse {
  schemaVersion: 1;
  requestedLocale: string | null;
  resolvedLocale: string;
  categories: StoreCategoryChoice[];
  storeProfile: StoreCategoryProfile;
}
