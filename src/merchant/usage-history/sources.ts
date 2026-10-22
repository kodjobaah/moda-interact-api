import type { Prisma } from "@prisma/client";

export interface SourceRecovery {
  recoveryId: string;
  customerName: string | null;
}

/** Only explicit, proven links through Shop-owned recovery/customer relations.
 * Reservation IDs and arbitrary source keys are never interpreted as recovery IDs.
 */
export async function readUsageRecoverySources(
  tx: Prisma.TransactionClient, shopId: string, sourceIds: readonly string[],
): Promise<Map<string, SourceRecovery>> {
  const ids = [...new Set(sourceIds)].filter((id) => id.length > 0 && id.length <= 191);
  if (ids.length === 0) return new Map();
  if (ids.length > 100) throw new Error("usage_source_page_overflow");
  const recoveries = await tx.checkoutRecovery.findMany({
    where: {
      shopId,
      customer: { is: { shopId } },
      OR: [
        { id: { in: ids } },
        { conversation: { is: { id: { in: ids }, OR: [{ shopId }, { shopId: null }] } } },
        { conversation: { is: { messages: { some: { id: { in: ids } } }, OR: [{ shopId }, { shopId: null }] } } },
      ],
    },
    select: {
      id: true,
      shopId: true,
      customer: { select: { shopId: true, firstName: true, lastName: true } },
      conversation: {
        select: {
          id: true, shopId: true,
          messages: { where: { id: { in: ids } }, select: { id: true } },
        },
      },
    },
    take: 301,
  });
  if (recoveries.length > 300) throw new Error("usage_source_result_overflow");
  const result = new Map<string, SourceRecovery>();
  const collisions = new Set<string>();
  for (const recovery of recoveries) {
    if (recovery.shopId !== shopId || !recovery.customer || recovery.customer.shopId !== shopId ||
        (recovery.conversation !== null && recovery.conversation.shopId !== null && recovery.conversation.shopId !== shopId)) continue;
    const customerName = [recovery.customer.firstName?.trim(), recovery.customer.lastName?.trim()]
      .filter(Boolean).join(" ").slice(0, 160) || null;
    const linkedIds = [recovery.id, recovery.conversation?.id, ...(recovery.conversation?.messages.map((message) => message.id) ?? [])];
    for (const id of linkedIds) {
      if (!id || !ids.includes(id)) continue;
      if (result.has(id) && result.get(id)?.recoveryId !== recovery.id) collisions.add(id);
      else result.set(id, { recoveryId: recovery.id, customerName });
    }
  }
  for (const id of collisions) result.delete(id);
  return result;
}
