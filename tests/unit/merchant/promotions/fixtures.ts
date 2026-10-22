export const revision = "a".repeat(64);
export const iso = "2026-11-01T00:00:00.000Z";
export const selection = {
  campaignId: "camp", merchantTitle: "English", quantityGranted: 9,
  reservedQuantity: 3, committedQuantity: 4, remainingQuantity: 2,
  expiresAt: iso, locked: true, exhausted: false, campaignStatus: "ACTIVE",
  targetEligible: true, spendable: true,
};
export const read = {
  schemaVersion: 1, revision,
  offers: [{ id: "camp", merchantTitle: "English", merchantDescription: "Details", quantity: 9,
    remainingQuantity: 2, expiresAt: iso, exhausted: false, previouslyClaimed: true,
    currentlySelected: true, eligible: true, selectable: false }],
  offersPagination: { page: 1, pageSize: 6, totalEntries: 1, totalPages: 1 },
  selection,
  history: { entries: [{ campaignId: "camp", campaignTitle: "English", status: "USED", quantityGranted: 9,
    committedQuantity: 4, remainingQuantity: 2, lastSelectedAt: null, expiresAt: iso }],
    page: 1, pageSize: 6, totalEntries: 1, totalPages: 1 },
};
