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

const SAFE_MODERATION_REASON = new Set([
  "moderation_blocked", "moderation_review_required", "moderation_empty_input", "moderation_unavailable",
]);
function isPlainMoney(value: unknown): boolean {
  return isObject(value) && hasKeys(value, ["amount", "currency"]) &&
    (value.amount === null || (typeof value.amount === "string" && DECIMAL.test(value.amount))) &&
    (value.currency === null || (typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency)));
}
function isBasket(value: unknown): boolean {
  return isObject(value) && hasKeys(value, ["items", "recoveryTotal", "unavailableReason"]) &&
    isPlainMoney(value.recoveryTotal) &&
    (value.unavailableReason === null || ["missing_snapshot", "invalid_snapshot", "oversized_snapshot", "partial_snapshot"].includes(value.unavailableReason as string)) &&
    Array.isArray(value.items) && value.items.length <= 50 && value.items.every((item: unknown) =>
      isObject(item) && hasKeys(item, ["title", "variantTitle", "quantity", "unitPrice", "lineTotal", "imageUrl"]) &&
      isStringOrNull(item.title, 255) && isStringOrNull(item.variantTitle, 255) &&
      (item.quantity === null || (Number.isSafeInteger(item.quantity) && (item.quantity as number) > 0 && (item.quantity as number) <= 1_000_000)) &&
      (item.unitPrice === null || isPlainMoney(item.unitPrice)) &&
      (item.lineTotal === null || isPlainMoney(item.lineTotal)) &&
      (item.imageUrl === null || (typeof item.imageUrl === "string" && item.imageUrl.length <= 1024 &&
        /^https:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/.test(item.imageUrl))));
}
function isConversation(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value) || !hasKeys(value, ["id", "controlMode", "controlRevision", "lastInboundAt", "windowExpiresAt", "followUp"]) ||
    !ID.test(String(value.id)) || !["AI", "HUMAN"].includes(value.controlMode as string) ||
    !Number.isSafeInteger(value.controlRevision) || (value.controlRevision as number) < 0 ||
    !isDateOrNull(value.lastInboundAt) || !isDateOrNull(value.windowExpiresAt) ||
    !isObject(value.followUp) || !hasKeys(value.followUp, ["sequence2Used", "initiatedBy"])) return false;
  return typeof value.followUp.sequence2Used === "boolean" &&
    (value.followUp.initiatedBy === null || ["HUMAN", "AGENT", "AUTOMATION"].includes(value.followUp.initiatedBy as string));
}
function isValue(value: unknown): boolean {
  if (!isObject(value) || !hasKeys(value, ["amount", "currency", "incomplete"]) ||
    typeof value.incomplete !== "boolean") return false;
  return (value.amount === null || (typeof value.amount === "string" && DECIMAL.test(value.amount))) &&
    (value.currency === null || (typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency))) &&
    value.incomplete === (value.amount === null || value.currency === null);
}

export function isDetailSummary(value: unknown): value is RecoveryDetailSummary {
  if (!isObject(value) || !hasKeys(value, ["schemaVersion", "timeZone", "id", "status", "value", "customer", "hasConversation", "basket", "conversation", "humanMessagingAllowed", "humanMessagingStatus", "milestones"]) ||
    value.schemaVersion !== 1 || !ID.test(String(value.id)) ||
    !isEnum(CheckoutRecoveryStatus, value.status) || !isValue(value.value) ||
    typeof value.timeZone !== "string" || value.timeZone.length > 128 ||
    typeof value.hasConversation !== "boolean" || !isBasket(value.basket) ||
    !isConversation(value.conversation) || value.hasConversation !== (value.conversation !== null) ||
    typeof value.humanMessagingAllowed !== "boolean" ||
    !["ACTIVE", "SUSPENDED"].includes(value.humanMessagingStatus as string) ||
    value.humanMessagingAllowed !== (value.humanMessagingStatus === "ACTIVE")) return false;
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
  if (!isObject(value) || !hasKeys(value, ["id", "createdAt", "direction", "sender", "content", "delivery", "moderationStatus", "moderationReasonCode"]) ||
    !ID.test(String(value.id)) || !isDate(value.createdAt) ||
    !isEnumOrNull(MessageDirection, value.direction) ||
    !isEnumOrNull(MessageSenderType, value.sender) ||
    !["PENDING", "ALLOW", "BLOCK", "REVIEW_REQUIRED", "RETRYABLE_ERROR"].includes(value.moderationStatus as string) ||
    (value.moderationReasonCode !== null && !SAFE_MODERATION_REASON.has(value.moderationReasonCode as string)) ||
    !isObject(value.content) ||
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
