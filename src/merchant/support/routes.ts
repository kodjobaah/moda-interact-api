import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { sendNoStoreJson } from "../../http/response.js";
import { SUPPORT_PATH,SUPPORT_READ_PATH,SupportConflictError,SupportIntegrityError,SupportNotFoundError,
  SupportRequestError,SupportUnavailableError,parseSupportQuery,validSupportMessageId,
  validSupportPage,validComposeResponse,validReadResponse } from "./contract.js";
import { hasRequestBody,readSupportCompose } from "./request.js";
import type { MerchantSupportReadService } from "./read.service.js";
import type { MerchantSupportCommandService } from "./commands.service.js";

/** Woo installation bearer only. WordPress owns browser admin authentication. */
export function createMerchantSupportRoutes(options:{authenticator:WooInstallationAuthenticator;
  read:MerchantSupportReadService; commands:MerchantSupportCommandService;
  logger:StructuredLogger; now?:()=>number}) {
  const {authenticator,read,commands,logger,now=Date.now}=options;
  return { async handle(request:IncomingMessage,response:ServerResponse):Promise<boolean> {
    const url=new URL(request.url ?? "/","http://localhost");
    const isMessages=url.pathname===SUPPORT_PATH, match=SUPPORT_READ_PATH.exec(url.pathname);
    const operation=isMessages && request.method==="GET" ? "list" :
      isMessages && request.method==="POST" ? "compose" :
        match && request.method==="POST" ? "mark_read" : null;
    if (!operation) return false;
    const started=now();
    try {
      // Only Support can read for a SUSPENDED Shop. Revocation and uninstallation remain denied.
      const principal=await authenticator.authenticate(request,{allowSuspendedShop:true});
      if ((request.url?.length ?? 0)>2048 || (operation!=="list" && url.search!="") ||
        (operation!=="compose" && hasRequestBody(request))) throw new SupportRequestError(400,"invalid_request");
      if (operation==="list") {
        const result=await read.read(principal,parseSupportQuery(url.searchParams));
        if (!validSupportPage(result)) throw new SupportIntegrityError();
        logger.info("merchant.support.read",{shopId:principal.shopId,page:result.page,pageSize:result.pageSize,
          count:result.items.length,durationMs:Math.max(0,now()-started)});
        sendNoStoreJson(response,200,result);
      } else if (operation==="compose") {
        const body=await readSupportCompose(request);
        const outcome=await commands.compose(principal,body);
        if (!validComposeResponse(outcome.response)) throw new SupportIntegrityError();
        logger.info("merchant.support.compose",{shopId:principal.shopId,messageId:outcome.response.messageId,
          replay:!outcome.created,durationMs:Math.max(0,now()-started)});
        sendNoStoreJson(response,outcome.created ? 201 : 200,outcome.response);
      } else {
        const messageId=match?.[1] ?? "";
        if (!validSupportMessageId(messageId)) throw new SupportRequestError(400,"invalid_request");
        const result=await commands.markRead(principal,messageId);
        if (!validReadResponse(result) || result.messageId!==messageId) throw new SupportIntegrityError();
        logger.info("merchant.support.mark_read",{shopId:principal.shopId,messageId});
        sendNoStoreJson(response,200,result);
      }
    } catch (error) {
      if (error instanceof WooUnauthenticatedError) sendNoStoreJson(response,401,{error:"unauthorized"});
      else if (error instanceof SupportRequestError) sendNoStoreJson(response,error.status,{error:error.code});
      else if (error instanceof SupportNotFoundError) sendNoStoreJson(response,404,{error:"not_found"});
      else if (error instanceof SupportUnavailableError) {
        logger.warn("merchant.support.denied",{operation,reason:"support_unavailable"});
        sendNoStoreJson(response,403,{error:"support_unavailable"});
      } else if (error instanceof SupportConflictError) {
        logger.warn("merchant.support.conflict",{operation,reason:"idempotency_conflict"});
        sendNoStoreJson(response,409,{error:"idempotency_conflict"});
      } else {
        // Keep a failing logging sink from changing the sanitized HTTP failure semantics.
        try {
          logger.error("merchant.support.failed",{operation,
            reason:error instanceof SupportIntegrityError ? "integrity" : "internal",error});
        } catch { /* shared logging is best-effort; preserve the original 500 response */ }
        sendNoStoreJson(response,500,{error:"internal_error"});
      }
    }
    return true;
  }};
}
