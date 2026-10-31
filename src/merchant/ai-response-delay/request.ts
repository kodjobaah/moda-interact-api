import type { IncomingMessage } from "node:http";
import { AiResponseDelayRequestError, MAX_AI_RESPONSE_DELAY_BODY_BYTES, parseAiResponseDelayWrite } from "./contract.js";

function headerValues(request: IncomingMessage, name: string): string[] {
  return request.rawHeaders.flatMap((header, index, all) =>
    index % 2 === 0 && header.toLowerCase() === name ? [all[index + 1] ?? ""] : []);
}

export function requestHasAiResponseDelayBody(request: IncomingMessage): boolean {
  return headerValues(request, "transfer-encoding").length > 0 ||
    headerValues(request, "content-length").some((value) => !/^0+$/.test(value));
}

export async function readAiResponseDelayWrite(request: IncomingMessage) {
  const contentTypes = headerValues(request, "content-type");
  const contentLengths = headerValues(request, "content-length");
  const encodings = headerValues(request, "content-encoding");
  if (contentTypes.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentTypes[0] ?? "") ||
    contentLengths.length > 1 || contentLengths.some((value) => !/^\d+$/.test(value)) ||
    encodings.length > 1 || (encodings.length === 1 && encodings[0]?.toLowerCase() !== "identity")) {
    throw new AiResponseDelayRequestError(400, "invalid_request");
  }
  if (contentLengths.length === 1 && Number(contentLengths[0]) > MAX_AI_RESPONSE_DELAY_BODY_BYTES) {
    throw new AiResponseDelayRequestError(413, "request_too_large");
  }

  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      length += buffer.length;
      if (length > MAX_AI_RESPONSE_DELAY_BODY_BYTES) {
        throw new AiResponseDelayRequestError(413, "request_too_large");
      }
      chunks.push(buffer);
    }
    if (length === 0) throw new AiResponseDelayRequestError(400, "invalid_request");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return parseAiResponseDelayWrite(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof AiResponseDelayRequestError) throw error;
    throw new AiResponseDelayRequestError(400, "invalid_request");
  }
}