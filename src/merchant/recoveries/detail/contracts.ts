import {
  CheckoutRecoveryStatus,
  MessageContentType,
  MessageDirection,
  MessageSenderType,
  MessageStatus,
  MessageTranscriptionStatus,
} from "@prisma/client";

export class RecoveryDetailIntegrityError extends Error {
  constructor() {
    super("recovery_detail_integrity_invalid");
    this.name = "RecoveryDetailIntegrityError";
  }
}

export interface RecoveryValue {
  amount: string | null;
  currency: string | null;
  incomplete: boolean;
}
export interface RecoveryDetailSummary {
  schemaVersion: 1;
  timeZone: string;
  id: string;
  status: CheckoutRecoveryStatus;
  customer: { firstName: string | null; lastName: string | null; email: string | null } | null;
  value: RecoveryValue;
  hasConversation: boolean;
  milestones: {
    detectedAt: string;
    messageSentAt: string | null;
    engagedAt: string | null;
    completedAt: string | null;
    expiredAt: string | null;
  };
}
export interface RecoveryDetailMessage {
  id: string;
  createdAt: string;
  direction: MessageDirection | null;
  sender: MessageSenderType | null;
  content: {
    type: MessageContentType;
    text: string | null;
    transcriptionStatus: MessageTranscriptionStatus | null;
  };
  delivery: {
    status: MessageStatus | null;
    sentAt: string | null;
    deliveredAt: string | null;
    readAt: string | null;
  } | null;
}
export interface RecoveryRelatedItem {
  id: string;
  status: CheckoutRecoveryStatus;
  value: RecoveryValue;
  detectedAt: string;
}
export interface RecoveryDetailPage<T> {
  schemaVersion: 1;
  items: T[];
  previousCursor: string | null;
  nextCursor: string | null;
}

export function boundedText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

export function recoveryValue(amount: { toString(): string } | null, currency: string | null): RecoveryValue {
  const value = amount?.toString() ?? null;
  if (value !== null && !/^-?\d{1,40}(?:\.\d{1,30})?$/.test(value)) {
    throw new RecoveryDetailIntegrityError();
  }
  const code = currency?.trim() ?? null;
  return {
    amount: value,
    currency: code && /^[A-Z]{3}$/.test(code) ? code : null,
    incomplete: value === null || !code || !/^[A-Z]{3}$/.test(code),
  };
}

/** Avoid sending unknown provider enum values, raw media, phone or tokens to the merchant browser. */
export function knownEnum<T extends string>(values: Record<string, T>, input: string | null): T | null {
  return input !== null && Object.values(values).includes(input as T) ? (input as T) : null;
}

export { MessageContentType, MessageDirection, MessageSenderType, MessageStatus, MessageTranscriptionStatus };
