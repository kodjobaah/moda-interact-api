import { Prisma, type PrismaClient } from "@prisma/client";
import type { WooInstallationPrincipal } from "../../../auth/woo-installation/principal.js";
import {
  ownedRecoveryConversation,
  requireCurrentWooShop,
} from "./admission.service.js";
import { SendHttpError } from "./contract.js";
import {
  configuredFollowUpDue,
  latestVerifiedCustomerInbound,
  requireRecoveryExecution,
  windowOpen,
} from "./eligibility.js";
import {
  readEligibleFollowUpChoices,
  type FollowUpChoicesResponse,
  type SenderWabaReader,
} from "./follow-up-catalogue.js";
import { readMerchantOutreach } from "../../recoveries/detail/merchant-outreach-read.js";

const EMPTY: FollowUpChoicesResponse = { schemaVersion: 1, templates: [] };

/** Read-only preview, NOT dispatch permission. The sending command rechecks
 * eligibility under the Shop / Conversation / initial-attempt locks; BG007
 * independently validates again at final dispatch.
 */
export class MerchantConversationFollowUpService {
  constructor(
    private readonly database: Pick<PrismaClient, "$transaction">,
    private readonly sender: SenderWabaReader | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(
    principal: WooInstallationPrincipal,
    conversationId: string,
  ): Promise<FollowUpChoicesResponse> {
    return this.database.$transaction(
      async (tx) => {
        const shop = await requireCurrentWooShop(tx, principal, false);
        const conversation = await ownedRecoveryConversation(
          tx,
          shop.id,
          conversationId,
          false,
        );
        if (
          conversation.controlMode !== "HUMAN" ||
          ["COMPLETED", "CANCELLED", "EXPIRED"].includes(
            conversation.recoveryStatus,
          )
        )
          return EMPTY;
        const restriction = await tx.shopHumanMessagingRestriction.findUnique({
          where: { shopId: shop.id },
          select: { status: true },
        });
        if (restriction && restriction.status !== "ACTIVE") return EMPTY;
        try {
          await requireRecoveryExecution(tx, shop.id, shop.onboardingCompleted);
        } catch (error) {
          if (
            error instanceof SendHttpError &&
            error.code === "send_entitlement_unavailable"
          )
            return EMPTY;
          throw error;
        }
        const now = this.now();
        if (!Number.isFinite(now.getTime())) return EMPTY;
        const evidence = await readMerchantOutreach(
          tx,
          {
            shopId: shop.id,
            recoveryId: conversation.checkoutRecoveryId,
            conversationId: conversation.id,
            platform: "WOOCOMMERCE",
          },
          now,
          false,
        );
        const initial = evidence.initial;
        if (
          !initial?.sentAt ||
          evidence.replyAnchor?.recipient !== initial.recipient ||
          evidence.followUpUsed ||
          !/^\+?[1-9]\d{6,14}$/.test(initial.recipient)
        )
          return EMPTY;
        const reachability = await tx.whatsAppRecipientReachability.findUnique({
          where: {
            shopId_recipient: { shopId: shop.id, recipient: initial.recipient },
          },
          select: { suppressUntil: true },
        });
        if (reachability?.suppressUntil && reachability.suppressUntil > now)
          return EMPTY;
        const inbound = evidence.replyAnchor?.sentAt
          ? await latestVerifiedCustomerInbound(
              tx,
              conversation.id,
              evidence.replyAnchor.sentAt,
              now,
            )
          : null;
        if (
          windowOpen(inbound, now) ||
          !configuredFollowUpDue(initial.followUpDueAt, now)
        )
          return EMPTY;
        const templates = await readEligibleFollowUpChoices(
          tx,
          shop.id,
          this.sender,
          now,
          {
            recoveryId: conversation.checkoutRecoveryId,
            conversationId: conversation.id,
            initial,
          },
        );
        return { schemaVersion: 1, templates };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
