import type { IncomingMessage, ServerResponse } from "node:http";
import { sanitizeLogFields, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { sendNoStoreJson as sendJson } from "../../http/response.js";
import { Prisma } from "@prisma/client";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { DISCOUNT_CATALOGUE_PATH, DISCOUNT_OFFERS_PATH, DiscountOffersError,
  MAX_DISCOUNT_SAVE_BYTES, parseSaveDiscountOffers, readCatalogueQuery } from "./contract.js";
import type { MerchantDiscountOffersService } from "./service.js";

/** Map the route's wrapper/database cause to explicit Shared log fields.
 * Shared owns Error serialization and bounds; raw stacks, query/meta payloads
 * are never projected. Database text needs boundary-specific redaction first.
 */
function safeErrorDiagnostic(error: unknown) {
  if (!(error instanceof Error)) return sanitizeLogFields({ errorType: typeof error });
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const databaseError = cause ?? error;
  const code = "code" in databaseError ? databaseError.code : undefined;
  const fields = sanitizeLogFields({
    error,
    ...(cause ? { errorCause: cause } : {}),
    ...(typeof code === "string" && /^(?:P\d{4}|[0-9A-Z]{5})$/.test(code) ? { databaseCode: code } : {}),
  });
  let redactionApplied = false;
  for (const [key, original] of [["error", error], ["errorCause", cause]] as const) {
    if (!original) continue;
    const redact = (text: string) => text
      // Prisma renders arguments/code frames before its originating reason.
      // Only retain an unindented final reason line for these database failures;
      // quoted arguments, numbered source lines and unknown layouts stay private.
      .replace(/\bInvalid[\s\S]*?\binvocation\b[\s\S]*/gi, invocation => {
        const reasonPattern = code === "P2003"
          ? /(?:^|\n)(Foreign key constraint (?:violated|failed)[^\r\n]*)\r?\n?$/
          : code === "P2002"
            ? /(?:^|\n)(Unique constraint failed[^\r\n]*)\r?\n?$/
            : code === "P2034"
              ? /(?:^|\n)(Transaction failed due to a write conflict or a deadlock[^\r\n]*)\r?\n?$/
              : undefined;
        const reason = reasonPattern?.exec(invocation)?.[1];
        if (!reason) return "[REDACTED]";
        const preamble = invocation.slice(0, invocation.lastIndexOf(reason));
        const header = /^Invalid[^\r\n]*\binvocation(?::| in\r?\n[^\r\n]+)\r?\n/.exec(preamble);
        if (!header) return "[REDACTED]";
        const context = preamble.slice(header[0].length);
        // Prisma emits either no context, a completed argument block followed
        // by a blank line, or numbered source lines immediately before reason.
        const complete = /^\s*$/.test(context)
          || /(?:^|\n)[ \t]*(?:\}\)?|\))[ \t]*\r?\n[ \t]*\r?\n$/.test(context)
          || /^(?:[ \t]*\r?\n)*(?:[ \t]*(?:→[ \t]*)?\d+[ \t]+[^\r\n]*\r?\n)+$/.test(context);
        return complete ? `[REDACTED]\n${reason}` : "[REDACTED]";
      })
      .replace(/\b(?:detail|context|query|parameters?|payload|customer)\s*[:=][\s\S]*/gi, "[REDACTED]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[REDACTED]")
      .replace(/\b(?:password|passwd|secret|credential|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|api[_-]?key|signature)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]")
      .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[REDACTED]")
      .replace(/\+?\d(?:[\d ().-]{5,}\d)/g, "[REDACTED]")
      .replace(/\b(?:secret|credential|password|token|authorization)\b/gi, "[REDACTED]");
    const name = redact(original.name);
    const message = redact(original.message);
    redactionApplied ||= name !== original.name || message !== original.message;
    // Redact original text before Shared truncation, including sensitive text
    // crossing its string boundary. Do not mutate the original exception.
    fields[key] = sanitizeLogFields({ ...fields[key] as Record<string, unknown>, name, message });
  }
  return sanitizeLogFields({ ...fields, redactionApplied });
}

function requestHasBody(request: IncomingMessage): boolean {
  return request.rawHeaders.some((v,i) => i%2===0 && (
    v.toLowerCase()==="transfer-encoding" ||
    v.toLowerCase()==="content-length" && request.rawHeaders[i+1]!=="0"));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const headers = (name:string) => request.rawHeaders.flatMap((header,i,all)=>
    i%2===0 && header.toLowerCase()===name?[all[i+1]??""]:[]);
  const types=headers("content-type");
  const lengths=headers("content-length");
  const encodings=headers("content-encoding");
  if (types.length!==1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(types[0]??"") ||
    lengths.length>1 || lengths.length===1 && !/^\d+$/.test(lengths[0]??"") ||
    encodings.length>1 || encodings.length===1 && encodings[0]?.toLowerCase()!=="identity") {
    throw new DiscountOffersError(400,"invalid_request");
  }
  if (lengths.length && Number(lengths[0])>MAX_DISCOUNT_SAVE_BYTES) {
    throw new DiscountOffersError(413,"request_too_large");
  }
  const buffers:Buffer[]=[];
  let count=0;
  try {
    for await (const chunk of request) {
      const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);
      count+=buffer.length;
      if (count>MAX_DISCOUNT_SAVE_BYTES) throw new DiscountOffersError(413,"request_too_large");
      buffers.push(buffer);
    }
    if (count===0) throw new DiscountOffersError(400,"invalid_request");
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(buffers))) as unknown;
  } catch(error) {
    if (error instanceof DiscountOffersError) throw error;
    throw new DiscountOffersError(400,"invalid_request");
  }
}

export function createMerchantDiscountOffersRoutes(options: {
  authenticator: WooInstallationAuthenticator;
  service: MerchantDiscountOffersService;
  logger: StructuredLogger;
}) {
  const {authenticator,service,logger}=options;
  return {
    async handle(request: IncomingMessage,response: ServerResponse):Promise<boolean> {
      const url=new URL(request.url??"/","http://localhost");
      const method=request.method??"";
      const catalogue=url.pathname===DISCOUNT_CATALOGUE_PATH && method==="GET";
      const offers=url.pathname===DISCOUNT_OFFERS_PATH && (method==="GET"||method==="PUT");
      if (!catalogue && !offers) return false;
      try {
        const principal=await authenticator.authenticate(request);
        if (catalogue) {
          if (requestHasBody(request)) throw new DiscountOffersError(400,"invalid_request");
          sendJson(response,200,await service.catalogue(principal,readCatalogueQuery(url.searchParams)));
        } else if (method==="GET") {
          if (url.search || requestHasBody(request)) throw new DiscountOffersError(400,"invalid_request");
          sendJson(response,200,await service.read(principal));
        } else {
          if (url.search) throw new DiscountOffersError(400,"invalid_request");
          sendJson(response,200,await service.save(principal,parseSaveDiscountOffers(await readBody(request))));
        }
        logger.info("merchant.discount_offers.access",{shopId:principal.shopId,
          operation:catalogue?"catalogue":method==="PUT"?"save":"read",outcome:"success"});
      } catch(error) {
        if (error instanceof WooUnauthenticatedError) sendJson(response,401,{error:"unauthorized"});
        else if (error instanceof DiscountOffersError) {
          logger.warn("merchant.discount_offers.access.denied",{reason:error.code,
            ...safeErrorDiagnostic(error),
          });
          sendJson(response,error.status,{error:error.code});
        } else if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002","P2034"].includes(error.code)) {
          logger.warn("merchant.discount_offers.access.denied", { reason: "offers_conflict",
            ...safeErrorDiagnostic(error),
          });
          sendJson(response,409,{error:"offers_conflict"});
        } else {
          logger.error("merchant.discount_offers.access.failed",{reason:"internal",
            ...safeErrorDiagnostic(error),
          });
          sendJson(response,500,{error:"internal_error"});
        }
      }
      return true;
    },
  };
}
