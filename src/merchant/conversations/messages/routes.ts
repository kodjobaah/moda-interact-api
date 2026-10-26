import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../../http/response.js";
import { readHumanSendRequest } from "./request.js";
import { POST_MESSAGE_PATH, SEND_STATUS_PATH, FOLLOW_UP_TEMPLATES_PATH, SendHttpError,
  isSendResponse, isSendStatusResponse, validIdentifier } from "./contract.js";
import type { MerchantConversationMessageAdmissionService } from "./admission.service.js";
import type { MerchantConversationFollowUpService } from "./follow-up.service.js";
import type { MerchantConversationSendStatusService } from "./status.service.js";

function headerHasBody(request: IncomingMessage): boolean {
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const header = request.rawHeaders[i]?.toLowerCase();
    if (header === "transfer-encoding" || header === "content-length" && !/^0+$/.test(request.rawHeaders[i+1] ?? ""))
      return true;
  }
  return false;
}

/** Woo installation alone can call these routes; there are no staff identities,
 * client-supplied moderation approvals, server-side sends or queue producers. */
export function createMerchantConversationMessageRoutes(input: {
  authenticator: WooInstallationAuthenticator;
  admission: MerchantConversationMessageAdmissionService;
  status: MerchantConversationSendStatusService;
  followUp: MerchantConversationFollowUpService;
  logger: StructuredLogger;
}) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const post = url.pathname.match(POST_MESSAGE_PATH);
      const get = url.pathname.match(SEND_STATUS_PATH);
      const catalogue = url.pathname.match(FOLLOW_UP_TEMPLATES_PATH);
      if (!(request.method === "POST" && post) && !(request.method === "GET" && (get || catalogue))) return false;
      try {
        const principal = await input.authenticator.authenticate(request);
        if (url.search || (request.url?.length ?? 0) > 2048) throw new SendHttpError(400,"invalid_request");
        if (post) {
          const conversationId = post[1]!;
          if (!validIdentifier(conversationId)) throw new SendHttpError(400,"invalid_request");
          const body = await readHumanSendRequest(request);
          const result = await input.admission.admit(principal, conversationId, body);
          if (!isSendResponse(result.response) || result.response.conversationId !== conversationId)
            throw new Error("invalid bounded admission response");
          input.logger.info("merchant.conversations.human_send.accepted", {
            shopId: principal.shopId, conversationId, commandId: result.response.commandId,
            kind: result.response.kind, replay: result.code === 200,
          });
          sendNoStoreJson(response, result.code, result.response);
        } else if (catalogue) {
          const conversationId = catalogue[1]!;
          if (!validIdentifier(conversationId) || headerHasBody(request))
            throw new SendHttpError(400,"invalid_request");
          const result = await input.followUp.read(principal, conversationId);
          if (result.schemaVersion !== 1 || !Array.isArray(result.templates) || result.templates.length > 30 ||
              result.templates.some((choice) => typeof choice.name !== "string" ||
                !/^[a-z][a-z0-9_]{0,254}$/.test(choice.name) ||
                typeof choice.language !== "string" || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(choice.language)))
            throw new Error("invalid bounded follow-up catalogue response");
          sendNoStoreJson(response, 200, result);
        } else if (get) {
          const conversationId = get[1]!; const commandId = get[2]!;
          if (!validIdentifier(conversationId) || !validIdentifier(commandId) || headerHasBody(request))
            throw new SendHttpError(400,"invalid_request");
          const result = await input.status.read(principal, conversationId, commandId);
          if (!isSendStatusResponse(result) || result.conversationId !== conversationId || result.commandId !== commandId)
            throw new Error("invalid bounded status response");
          sendNoStoreJson(response, 200, result);
        }
      } catch (error) {
        if (error instanceof WooUnauthenticatedError) sendNoStoreJson(response, 401, { error: "unauthorized" });
        else if (error instanceof SendHttpError) {
          if (error.status !== 404) input.logger.warn("merchant.conversations.human_send.denied", { reason: error.code });
          sendNoStoreJson(response, error.status, { error: error.code });
        } else {
          input.logger.error("merchant.conversations.human_send.failed", { reason: "internal_error" });
          sendNoStoreJson(response, 500, { error: "internal_error" });
        }
      }
      return true;
    },
  };
}
