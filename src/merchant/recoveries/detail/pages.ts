import {
  MessageContentType,
  MessageDirection,
  MessageTranscriptionStatus,
  Prisma,
} from "@prisma/client";
import {
  RecoveryDetailIntegrityError,
  knownEnum,
  recoveryValue,
  type RecoveryDetailMessage,
  type RecoveryDetailPage,
  type RecoveryRelatedItem,
} from "./contracts.js";
import { encodeDetailCursor, type DetailNavigation } from "./cursor.js";
import { messageModeration, readMessageModeration, type MessageModeration } from "./moderation.js";

const messageSelect = {
  id: true,
  createdAt: true,
  direction: true,
  senderType: true,
  status: true,
  contentType: true,
  content: true,
  transcriptionStatus: true,
  sentAt: true,
  deliveredAt: true,
  readAt: true,
} as const satisfies Prisma.ConversationMessageSelect;
type MessageRow = Prisma.ConversationMessageGetPayload<{ select: typeof messageSelect }>;

const relatedSelect = {
  id: true,
  status: true,
  totalPrice: true,
  currency: true,
  detectedAt: true,
} as const satisfies Prisma.CheckoutRecoverySelect;
type RelatedRow = Prisma.CheckoutRecoveryGetPayload<{ select: typeof relatedSelect }>;
type ReadTransaction = Prisma.TransactionClient;

function beforeMessage(at: Date, id: string): Prisma.ConversationMessageWhereInput {
  return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] };
}
function afterMessage(at: Date, id: string): Prisma.ConversationMessageWhereInput {
  return { OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: id } }] };
}
function newerRecovery(at: Date, id: string): Prisma.CheckoutRecoveryWhereInput {
  return { OR: [{ detectedAt: { gt: at } }, { detectedAt: at, id: { gt: id } }] };
}
function olderRecovery(at: Date, id: string): Prisma.CheckoutRecoveryWhereInput {
  return { OR: [{ detectedAt: { lt: at } }, { detectedAt: at, id: { lt: id } }] };
}

function messageDto(row: MessageRow, moderation: MessageModeration): RecoveryDetailMessage {
  const direction = knownEnum(MessageDirection, row.direction);
  const contentType = knownEnum(MessageContentType, row.contentType) ?? MessageContentType.UNSUPPORTED;
  const transcription = contentType === MessageContentType.AUDIO
    ? knownEnum(MessageTranscriptionStatus, row.transcriptionStatus) : null;
  const readable = contentType === MessageContentType.TEXT ||
    (contentType === MessageContentType.AUDIO && transcription === MessageTranscriptionStatus.COMPLETED);
  if (readable && row.content.length > 32000) throw new RecoveryDetailIntegrityError();
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    direction,
    sender: row.senderType,
    ...moderation,
    content: {
      type: contentType,
      text: readable ? row.content : null,
      transcriptionStatus: transcription,
    },
    delivery: direction === MessageDirection.OUTBOUND ? {
      status: row.status,
      sentAt: row.sentAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      readAt: row.readAt?.toISOString() ?? null,
    } : null,
  };
}

/** Chronological display with keyset pagination; latest and previous read backwards then reverse. */
export async function readMessagePage(
  tx: ReadTransaction,
  shopId: string,
  recoveryId: string,
  conversationId: string,
  nav: DetailNavigation,
): Promise<RecoveryDetailPage<RecoveryDetailMessage>> {
  const descending = nav.direction === "latest" || nav.direction === "previous";
  const where: Prisma.ConversationMessageWhereInput = {
    conversationId,
    ...(nav.boundary ? (descending
      ? beforeMessage(nav.boundary.at, nav.boundary.id)
      : afterMessage(nav.boundary.at, nav.boundary.id)) : {}),
  };
  const fetched = await tx.conversationMessage.findMany({
    where,
    orderBy: [{ createdAt: descending ? "desc" : "asc" }, { id: descending ? "desc" : "asc" }],
    take: 51,
    select: messageSelect,
  });
  const rows = fetched.slice(0, 50);
  if (descending) rows.reverse();
  if (rows.length === 0) return { schemaVersion: 1, items: [], previousCursor: null, nextCursor: null };
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const oppositeWhere = descending
    ? { conversationId, ...afterMessage(last.createdAt, last.id) }
    : { conversationId, ...beforeMessage(first.createdAt, first.id) };
  const [moderation, opposite] = await Promise.all([
    // Exact returned page only, never a full moderation-history export.
    readMessageModeration(tx, shopId, conversationId, rows.map((row) => row.id)),
    nav.boundary ? tx.conversationMessage.findFirst({
      where: oppositeWhere,
      select: { id: true },
    }) : Promise.resolve(null),
  ]);
  const hasFetchedDirection = fetched.length > rows.length;
  const hasPrevious = descending ? hasFetchedDirection : Boolean(opposite);
  const hasNext = descending ? Boolean(opposite) : hasFetchedDirection;
  return {
    schemaVersion: 1,
    items: rows.map((row) => messageDto(row, messageModeration(row.id, moderation))),
    previousCursor: hasPrevious ? encodeDetailCursor(shopId, recoveryId, "messages", "previous", {
      at: first.createdAt, id: first.id,
    }) : null,
    nextCursor: hasNext ? encodeDetailCursor(shopId, recoveryId, "messages", "next", {
      at: last.createdAt, id: last.id,
    }) : null,
  };
}

/** Newest-first related recoveries; no cross-shop/customer fallback or PII guessing. */
export async function readRelatedPage(
  tx: ReadTransaction,
  shopId: string,
  recoveryId: string,
  customerId: string,
  nav: DetailNavigation,
): Promise<RecoveryDetailPage<RecoveryRelatedItem>> {
  const newer = nav.direction === "previous";
  const base: Prisma.CheckoutRecoveryWhereInput = {
    shopId,
    customerId,
    id: { not: recoveryId },
  };
  const where: Prisma.CheckoutRecoveryWhereInput = {
    ...base,
    ...(nav.boundary ? (newer
      ? newerRecovery(nav.boundary.at, nav.boundary.id)
      : olderRecovery(nav.boundary.at, nav.boundary.id)) : {}),
  };
  const fetched = await tx.checkoutRecovery.findMany({
    where,
    orderBy: [{ detectedAt: newer ? "asc" : "desc" }, { id: newer ? "asc" : "desc" }],
    take: 6,
    select: relatedSelect,
  });
  const rows: RelatedRow[] = fetched.slice(0, 5);
  if (newer) rows.reverse();
  if (!rows.length) return { schemaVersion: 1, items: [], previousCursor: null, nextCursor: null };
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const oppositeWhere = newer
    ? { ...base, ...olderRecovery(last.detectedAt, last.id) }
    : { ...base, ...newerRecovery(first.detectedAt, first.id) };
  const opposite = nav.boundary ? await tx.checkoutRecovery.findFirst({
    where: oppositeWhere,
    select: { id: true },
  }) : null;
  const hasFetchedDirection = fetched.length > rows.length;
  const hasPrevious = newer ? hasFetchedDirection : Boolean(opposite);
  const hasNext = newer ? Boolean(opposite) : hasFetchedDirection;
  return {
    schemaVersion: 1,
    items: rows.map((row) => ({
      id: row.id,
      status: row.status,
      value: recoveryValue(row.totalPrice, row.currency),
      detectedAt: row.detectedAt.toISOString(),
    })),
    previousCursor: hasPrevious ? encodeDetailCursor(shopId, recoveryId, "related", "previous", {
      at: first.detectedAt, id: first.id,
    }) : null,
    nextCursor: hasNext ? encodeDetailCursor(shopId, recoveryId, "related", "next", {
      at: last.detectedAt, id: last.id,
    }) : null,
  };
}
