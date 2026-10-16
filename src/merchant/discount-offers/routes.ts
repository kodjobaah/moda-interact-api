import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { Prisma } from "@prisma/client";
import { WooUnauthenticatedError, type WooInstallationAuthenticator } from "../../auth/woo-installation/authenticator.js";
import { DISCOUNT_CATALOGUE_PATH, DISCOUNT_OFFERS_PATH, DiscountOffersError,
  MAX_DISCOUNT_SAVE_BYTES, parseSaveDiscountOffers, readCatalogueQuery } from "./contract.js";
import type { MerchantDiscountOffersService } from "./service.js";

function sendJson(response: ServerResponse, status: number, result: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status,{"cache-control":"no-store","content-type":"application/json; charset=utf-8",
    "x-content-type-options":"nosniff"});
  response.end(JSON.stringify(result));
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
          logger.warn("merchant.discount_offers.access.denied",{reason:error.code});
          sendJson(response,error.status,{error:error.code});
        } else if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002","P2034"].includes(error.code)) {
          sendJson(response,409,{error:"offers_conflict"});
        } else {
          logger.error("merchant.discount_offers.access.failed",{reason:"internal"});
          sendJson(response,500,{error:"internal_error"});
        }
      }
      return true;
    },
  };
}
