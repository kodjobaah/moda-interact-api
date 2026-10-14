import {
  CheckoutRecoveryStatus,
  MessageContentType,
  MessageDirection,
  MessageSenderType,
  MessageStatus,
  MessageTranscriptionStatus,
} from "@prisma/client";
import type { RecoveryDetailSummary, RecoveryDetailPage, RecoveryDetailMessage, RecoveryRelatedItem } from "./contracts.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID = /^[A-Za-z0-9_-]{1,191}$/;
const DECIMAL = /^-?\d{1,40}(?:\.\d{1,30})?$/;
const CURSOR = /^[A-Za-z0-9_-]{1,1024}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).sort().join(",") === [...fields].sort().join(",");
const isStringOrNull = (value: unknown, max: number) =>
  value === null || (typeof value === "string" && value.length <= max);
const isDate = (value: unknown) => typeof value === "string" && ISO.test(value) &&
  Number.isFinite(Date.parse(value));
const isDateOrNull = (value: unknown) => value === null || isDate(value);
const isEnum = (set: Record<string, string>, value: unknown) =>
  typeof value === "string" && Object.values(set).includes(value);
const isEnumOrNull = (set: Record<string, string>, value: unknown) =>
  value === null || isEnum(set, value);

function isValue(value: unknown): boolean {
  if (!isObject(value) || !hasKeys(value, ["amount", "currency", "incomplete"]) ||
    typeof value.incomplete !== "boolean") return false;
  return (value.amount === null || (typeof value.amount === "string" && DECIMAL.test(value.amount))) &&
    (value.currency === null || (typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency))) &&
    value.incomplete === (value.amount === null || value.currency === null);
}

export function isDetailSummary(value: unknown): value is RecoveryDetailSummary {
  if (!isObject(value) || !hasKeys(value, ["schemaVersion", "timeZone", "id", "status", "value", "customer", "hasConversation", "milestones"]) ||
    value.schemaVersion !== 1 || !ID.test(String(value.id)) ||
    !isEnum(CheckoutRecoveryStatus, value.status) || !isValue(value.value) ||
    typeof value.timeZone !== "string" || value.timeZone.length > 128 ||
    typeof value.hasConversation !== "boolean") return false;
  const customer = value.customer;
  if (customer !== null && (!isObject(customer) ||
    !hasKeys(customer, ["firstName", "lastName", "email"]) ||
    !isStringOrNull(customer.firstName, 80) || !isStringOrNull(customer.lastName, 80) ||
    !isStringOrNull(customer.email, 320))) return false;
  const milestones = value.milestones;
  return isObject(milestones) &&
    hasKeys(milestones, ["detectedAt", "messageSentAt", "engagedAt", "completedAt", "expiredAt"]) &&
    isDate(milestones.detectedAt) &&
    ["messageSentAt", "engagedAt", "completedAt", "expiredAt"].every((key) => isDateOrNull(milestones[key]));
}

function isPage<T>(value: unknown, limit: number, validateItem: (item: unknown) => item is T):
  value is RecoveryDetailPage<T> {
  return isObject(value) && hasKeys(value, ["schemaVersion", "items", "previousCursor", "nextCursor"]) &&
    value.schemaVersion === 1 &&
    (value.previousCursor === null || (typeof value.previousCursor === "string" && CURSOR.test(value.previousCursor))) &&
    (value.nextCursor === null || (typeof value.nextCursor === "string" && CURSOR.test(value.nextCursor))) &&
    Array.isArray(value.items) && value.items.length <= limit && value.items.every(validateItem);
}

function isMessage(value: unknown): value is RecoveryDetailMessage {
  if (!isObject(value) || !hasKeys(value, ["id", "createdAt", "direction", "sender", "content", "delivery"]) ||
    !ID.test(String(value.id)) || !isDate(value.createdAt) ||
    !isEnumOrNull(MessageDirection, value.direction) ||
    !isEnumOrNull(MessageSenderType, value.sender) || !isObject(value.content) ||
    !hasKeys(value.content, ["type", "text", "transcriptionStatus"]) ||
    !isEnum(MessageContentType, value.content.type) ||
    !isStringOrNull(value.content.text, 32000) ||
    !isEnumOrNull(MessageTranscriptionStatus, value.content.transcriptionStatus)) return false;
  const delivery = value.delivery;
  return delivery === null || (isObject(delivery) &&
    hasKeys(delivery, ["status", "sentAt", "deliveredAt", "readAt"]) &&
    isEnumOrNull(MessageStatus, delivery.status) &&
    ["sentAt", "deliveredAt", "readAt"].every((key) => isDateOrNull(delivery[key])));
}

function isRelated(value: unknown): value is RecoveryRelatedItem {
  return isObject(value) && hasKeys(value, ["id", "status", "detectedAt", "value"]) &&
    ID.test(String(value.id)) &&
    isEnum(CheckoutRecoveryStatus, value.status) && isValue(value.value) && isDate(value.detectedAt);
}

export function isMessagePage(value: unknown): value is RecoveryDetailPage<RecoveryDetailMessage> {
  return isPage(value, 50, isMessage);
}
export function isRelatedPage(value: unknown): value is RecoveryDetailPage<RecoveryRelatedItem> {
  return isPage(value, 5, isRelated);
}
