import type { RecoveryStatusFilter, RecoveryPageSize } from "./query.js";

/** Provider-neutral DTO. Formatting, currencies and translations belong to the UI. */
export interface RecoveryListItem {
  id: string;
  status: "DETECTED" | "MESSAGE_SENT" | "ENGAGED" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  detectedAt: string;
  lastActivityAt: string;
  totalPrice: string | null;
  currency: string | null;
  customer: { displayName: string | null; email: string | null } | null;
}

export interface RecoveryListResponse {
  schemaVersion: 1;
  timeZone: string;
  from: string;
  to: string;
  q: string;
  status: RecoveryStatusFilter;
  page: number;
  pageSize: RecoveryPageSize;
  total: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
  items: RecoveryListItem[];
}

export class RecoveryListIntegrityError extends Error {
  constructor() {
    super("recovery_list_integrity_invalid");
    this.name = "RecoveryListIntegrityError";
  }
}
