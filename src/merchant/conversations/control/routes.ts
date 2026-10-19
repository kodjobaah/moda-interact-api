import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../../http/response.js";
import { readConversationControlRequest } from "./request.js";
import {
  CONVERSATION_CONTROL_PATH, ConversationControlConflictError,
  ConversationControlIntegrityError, ConversationControlNotFoundError,
  ConversationControlRequestError, ConversationControlSuspendedError,
  validConversationId, validControlResponse,
} from "./contract.js";
import type { MerchantConversationControlService } from "./service.js";

export function createMerchantConversationControlRoute(input: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantConversationControlService;
  logger: StructuredLogger;
}) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const match = url.pathname.match(CONVERSATION_CONTROL_PATH);
      if (!match || request.method !== "POST") return false;
      try {
        const principal = await input.authenticator.authenticate(request);
        const conversationId = match[1]!;
        if (url.search || !validConversationId(conversationId)) {
          throw new ConversationControlRequestError(400, "invalid_request");
        }
        const body = await readConversationControlRequest(request);
        const outcome = await input.service.change(principal, conversationId, body);
        if (!validControlResponse(outcome) || outcome.conversationId !== conversationId) {
          throw new ConversationControlIntegrityError();
        }
        input.logger.info("merchant.conversation.control.changed", {
          shopId: principal.shopId, conversationId, mode: outcome.controlMode,
          revision: outcome.controlRevision,
        });
        sendNoStoreJson(response, 200, outcome);
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) sendNoStoreJson(response, 401, { error: "unauthorized" });
        else if (error instanceof ConversationControlRequestError) sendNoStoreJson(response, error.status, { error: error.code });
        else if (error instanceof ConversationControlNotFoundError) sendNoStoreJson(response, 404, { error: "not_found" });
        else if (error instanceof ConversationControlSuspendedError) {
          input.logger.warn("merchant.conversation.control.denied", { reason: "human_messaging_suspended" });
          sendNoStoreJson(response, 403, { error: "human_messaging_suspended" });
        } else if (error instanceof ConversationControlConflictError) {
          input.logger.warn("merchant.conversation.control.conflict", { reason: error.code });
          sendNoStoreJson(response, 409, { error: error.code, ...error.current });
        } else if (error instanceof ConversationControlIntegrityError) {
          input.logger.warn("merchant.conversation.control.failed", { reason: "integrity" });
          sendNoStoreJson(response, 409, { error: "conversation_control_integrity_invalid" });
        } else {
          input.logger.error("merchant.conversation.control.failed", { reason: "internal" });
          sendNoStoreJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
