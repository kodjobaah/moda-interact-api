import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../../auth/woo-installation/principal.js";
import { WooUnauthenticatedError } from "../../../auth/woo-installation/authenticator.js";
import { humanPayloadDigest, SendHttpError, type HumanSendInput, type SendResponse } from "./contract.js";
import { latestVerifiedCustomerInbound, merchantFollowUpWindowClosed,
  requireRecoveryExecution, windowOpen } from "./eligibility.js";

interface ShopRow { id: string; domain: string; status: string; platform: string;
  shopifyShopId: string | null; onboardingCompleted: boolean }
interface InstallationRow { id: string; shopId: string; canonicalSiteUrl: string;
  credentialVersion: number; status: string; revokedAt: Date | null }
interface ConversationRow { id: string; shopId: string | null; checkoutRecoveryId: string;
  controlMode: string; controlRevision: number; type: string; recoveryStatus: string }

/** Shared with status GET: always verify Shop -> installation in transaction.
 * For admission Shop FOR UPDATE also fences the absent restriction-row case.
 */
export async function requireCurrentWooShop(tx: Prisma.TransactionClient, principal: WooInstallationPrincipal,
  write: boolean): Promise<ShopRow> {
  const shopRows = write ? await tx.$queryRaw<ShopRow[]>`SELECT "id","domain","status"::text AS "status",
    "platform"::text AS "platform","shopifyShopId","onboardingCompleted"
    FROM "commerce"."Shop" WHERE "id"=${principal.shopId} FOR UPDATE`
    : await tx.$queryRaw<ShopRow[]>`SELECT "id","domain","status"::text AS "status",
    "platform"::text AS "platform","shopifyShopId","onboardingCompleted"
    FROM "commerce"."Shop" WHERE "id"=${principal.shopId}`;
  const shop = shopRows[0];
  if (!shop || shop.domain !== principal.canonicalSiteUrl || shop.platform !== "WOOCOMMERCE" ||
    shop.shopifyShopId !== null || shop.status !== "ACTIVE") throw new WooUnauthenticatedError();
  const installations = await tx.$queryRaw<InstallationRow[]>`SELECT "id","shopId","canonicalSiteUrl",
    "credentialVersion","status"::text AS "status","revokedAt"
    FROM "woocommerce"."WooCommerceInstallation" WHERE "id"=${principal.installationId} FOR SHARE`;
  const installation = installations[0];
  if (!installation || installation.id !== principal.installationId || installation.shopId !== shop.id ||
    installation.canonicalSiteUrl !== principal.canonicalSiteUrl ||
    installation.credentialVersion !== principal.credentialVersion || installation.status !== "ACTIVE" ||
    installation.revokedAt !== null) throw new WooUnauthenticatedError();
  return shop;
}

export async function ownedRecoveryConversation(tx: Prisma.TransactionClient,
  shopId: string, conversationId: string, lock: boolean): Promise<ConversationRow> {
  const records = lock ? await tx.$queryRaw<ConversationRow[]>`SELECT c."id",c."shopId",c."checkoutRecoveryId",
    c."controlMode"::text AS "controlMode",c."controlRevision",c."type"::text AS "type",
    r."status"::text AS "recoveryStatus"
    FROM "whatsapp"."Conversation" c JOIN "commerce"."CheckoutRecovery" r
      ON r."id"=c."checkoutRecoveryId"
    WHERE c."id"=${conversationId} AND r."shopId"=${shopId}
    FOR UPDATE OF c FOR SHARE OF r`
    : await tx.$queryRaw<ConversationRow[]>`SELECT c."id",c."shopId",c."checkoutRecoveryId",
      c."controlMode"::text AS "controlMode",c."controlRevision",c."type"::text AS "type",
      r."status"::text AS "recoveryStatus"
      FROM "whatsapp"."Conversation" c JOIN "commerce"."CheckoutRecovery" r
        ON r."id"=c."checkoutRecoveryId"
      WHERE c."id"=${conversationId} AND r."shopId"=${shopId}`;
  const conversation = records[0];
  if (!conversation || conversation.type !== "RECOVERY" ||
    (conversation.shopId !== null && conversation.shopId !== shopId)) throw new SendHttpError(404,"not_found");
  return conversation;
}

const commandReply = (record: { id: string; conversationId: string; kind: string;
  state: string; expectedControlRevision: number }): SendResponse => ({
  schemaVersion: 1, commandId: record.id, conversationId: record.conversationId,
  kind: record.kind as SendResponse["kind"], state: record.state as SendResponse["state"],
  controlRevision: record.expectedControlRevision,
});
const goodRecipient = (recipient: string): boolean => /^\+?[1-9]\d{6,14}$/.test(recipient);

/** API only produces durable commands; Background owns Meta, moderation, Redis and credits.
 * Shop -> installation -> conversation -> initial outreach -> sequence-two/command
 * is the same lock order as the DATABASE-001/BG002 provider fence.
 */
export class MerchantConversationMessageAdmissionService {
  constructor(private readonly database: Pick<PrismaClient,"$transaction">,
    private readonly now: () => Date = () => new Date()) {}

  async admit(principal: WooInstallationPrincipal, conversationId: string,
    input: HumanSendInput): Promise<{ code: 200 | 202; response: SendResponse }> {
    const digest = humanPayloadDigest(conversationId, input);
    try {
      return await this.database.$transaction(async (tx) => {
        const shop = await requireCurrentWooShop(tx, principal, true);
        const conversation = await ownedRecoveryConversation(tx, principal.shopId, conversationId, true);
        // Replay lookup precedes window/mode/restriction checks: a retry never
        // reopens a cancelled/denied command or consumes another sequence-two slot.
        const prior = await tx.merchantConversationSendCommand.findUnique({
          where: { shopId_idempotencyKey: { shopId: principal.shopId, idempotencyKey: input.idempotencyKey } },
        });
        if (prior) {
          if (prior.conversationId !== conversationId || prior.payloadSha256 !== digest ||
            prior.kind !== input.kind || prior.expectedControlRevision !== input.expectedControlRevision)
            throw new SendHttpError(409,"idempotency_conflict");
          return { code: 200 as const, response: commandReply(prior) };
        }
        if (conversation.controlMode !== "HUMAN") throw new SendHttpError(409,"not_human_controlled");
        if (conversation.controlRevision !== input.expectedControlRevision)
          throw new SendHttpError(409,"stale_control_revision");
        const restriction = await tx.shopHumanMessagingRestriction.findUnique({
          where: { shopId: principal.shopId }, select: { status: true },
        });
        if (restriction?.status === "SUSPENDED") throw new SendHttpError(403,"human_messaging_suspended");
        if (restriction && restriction.status !== "ACTIVE") throw new SendHttpError(409,"not_human_controlled");
        if (["COMPLETED","CANCELLED","EXPIRED"].includes(conversation.recoveryStatus))
          throw new SendHttpError(409,"follow_up_unavailable");
        await requireRecoveryExecution(tx, shop.id, shop.onboardingCompleted);

        const now = this.now();
        if (!Number.isFinite(now.getTime())) throw new SendHttpError(500,"internal_error");
        const attempts = await tx.$queryRaw<Array<{ id: string; recipient: string; sentAt: Date | null }>>`
          SELECT "id","recipient","sentAt" FROM "commerce"."RecoveryOutreachAttempt"
          WHERE "checkoutRecoveryId"=${conversation.checkoutRecoveryId} AND "sequence"=1 FOR UPDATE`;
        const initial = attempts[0];
        if (!initial?.sentAt) throw new SendHttpError(409,"follow_up_unavailable");
        const recipient = initial.recipient;
        if (!goodRecipient(recipient)) throw new SendHttpError(409,"recipient_unavailable");
        const reachability = await tx.whatsAppRecipientReachability.findUnique({
          where: { shopId_recipient: { shopId: principal.shopId, recipient } },
          select: { suppressUntil: true },
        });
        if (reachability?.suppressUntil && reachability.suppressUntil > now)
          throw new SendHttpError(409,"recipient_unavailable");
        const lastInbound = await latestVerifiedCustomerInbound(tx, conversation.id, initial.sentAt, now);
        let attemptId: string | undefined;
        if (input.kind === "HUMAN_TEXT") {
          if (!windowOpen(lastInbound, now)) throw new SendHttpError(409,"service_window_closed");
        } else {
          if (!merchantFollowUpWindowClosed(initial.sentAt, lastInbound, now))
            throw new SendHttpError(409,"service_window_closed");
          // An exact, shop-owned, approved variant is the server allowlist.
          // Reject ambiguous provider-account variants rather than guessing.
          const approved = await tx.whatsAppTemplateVariant.findMany({ where: {
            shopId: principal.shopId, purpose: "checkout-recovery", enabled: true, status: "APPROVED",
            providerTemplateName: input.templateName, providerLanguageCode: input.templateLanguage,
          }, select: { id: true, providerAccountId: true }, take: 3 });
          if (approved.length !== 1) throw new SendHttpError(409,"template_not_allowed");
          // Create only the shared existing sequence=2. Shop/Conversation and
          // initial attempt remain locked while the claim and command commit.
          await tx.$executeRaw`INSERT INTO "commerce"."RecoveryOutreachAttempt"
            ("id","checkoutRecoveryId","recipient","sequence","trigger","status",
             "configuredOfferMode","fixedShopifyDiscountId","offerSnapshot","createdAt","updatedAt")
            SELECT ${randomUUID()}, a."checkoutRecoveryId", a."recipient",2,
              'NO_RESPONSE_FOLLOW_UP'::"commerce"."RecoveryOutreachTrigger",
              'PENDING'::"commerce"."RecoveryOutreachStatus",
              a."configuredOfferMode",a."fixedShopifyDiscountId",a."offerSnapshot",${now},${now}
            FROM "commerce"."RecoveryOutreachAttempt" a WHERE a."id"=${initial.id}
            ON CONFLICT ("checkoutRecoveryId","sequence") DO NOTHING`;
          const sequenceTwo = await tx.$queryRaw<Array<{ id: string; status: string;
            initiationKey: string | null; outboundMessageId: string | null }>>`
            SELECT "id","status"::text AS "status","initiationKey","outboundMessageId"
            FROM "commerce"."RecoveryOutreachAttempt"
            WHERE "checkoutRecoveryId"=${conversation.checkoutRecoveryId} AND "sequence"=2 FOR UPDATE`;
          const candidate = sequenceTwo[0];
          if (!candidate || candidate.status !== "PENDING" || candidate.initiationKey !== null ||
            candidate.outboundMessageId !== null) throw new SendHttpError(409,"follow_up_unavailable");
          const claimed = await tx.recoveryOutreachAttempt.updateMany({
            where: { id: candidate.id, status: "PENDING", initiationKey: null, outboundMessageId: null },
            data: { initiatedBy: "HUMAN", initiationKey: input.idempotencyKey,
              claimedAt: now, trigger: "POST_WINDOW_FOLLOW_UP" },
          });
          if (claimed.count !== 1) throw new SendHttpError(409,"follow_up_unavailable");
          attemptId = candidate.id;
        }
        // A template command must never be accepted without its durable
        // sequence-two claim, even if a future branch changes the claim path.
        if (input.kind === "RECOVERY_FOLLOW_UP_TEMPLATE" && !attemptId)
          throw new SendHttpError(500, "internal_error");
        const command = await tx.merchantConversationSendCommand.create({ data: {
          shopId: principal.shopId, conversationId, idempotencyKey: input.idempotencyKey,
          payloadSha256: digest, expectedControlRevision: input.expectedControlRevision,
          kind: input.kind, recipientSnapshot: recipient,
          ...(input.kind === "HUMAN_TEXT" ? { textBody: input.textBody }
            : { templateName: input.templateName, templateLanguageCode: input.templateLanguage,
                templateParameters: Array.isArray(input.templateParameters)
                  ? input.templateParameters as string[] : {},
                ...(attemptId ? { recoveryOutreachAttemptId: attemptId } : {}) }),
        } });
        return { code: 202 as const, response: commandReply(command) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002","P2034"].includes(error.code)) {
        // Unique idempotency races, sequence-two contention and serialization
        // conflicts must not be interpreted as successful fresh admissions.
        throw new SendHttpError(409, "idempotency_conflict");
      }
      throw error;
    }
  }
}
