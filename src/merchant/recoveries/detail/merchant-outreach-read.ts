import type { Prisma } from "@prisma/client";
import { attemptSelect } from "./outreach-read.js";
import { MAX_OUTREACH_HISTORY } from "./outreach-projection.js";
import {
  resolveMerchantOutreach,
  type MerchantOutreachScope,
} from "./merchant-outreach.js";

/** The caller has authenticated ownership in the same transaction. Writes
 * already hold the Shop and Conversation locks shared with Background. Lock
 * the bounded physical history in sequence order before any sequence-two
 * write; read-only previews use RepeatableRead without additional locks. */
export async function readMerchantOutreach(
  tx: Prisma.TransactionClient,
  scope: MerchantOutreachScope,
  now: Date,
  lock: boolean,
) {
  if (lock)
    await tx.$queryRaw<Array<{ id: string }>>`
    SELECT a."id" FROM "commerce"."RecoveryOutreachAttempt" a
    JOIN "commerce"."CheckoutRecovery" r ON r."id"=a."checkoutRecoveryId"
    WHERE a."checkoutRecoveryId"=${scope.recoveryId} AND r."shopId"=${scope.shopId}
    ORDER BY a."sequence" ASC LIMIT ${MAX_OUTREACH_HISTORY + 1} FOR UPDATE OF a`;
  const attempts = await tx.recoveryOutreachAttempt.findMany({
    where: {
      checkoutRecoveryId: scope.recoveryId,
      checkoutRecovery: { shopId: scope.shopId },
    },
    orderBy: { sequence: "asc" },
    take: MAX_OUTREACH_HISTORY + 1,
    select: attemptSelect,
  });
  return resolveMerchantOutreach(scope, attempts, now);
}
