import type { IncomingMessage } from "node:http";
import { readBoundedBody } from "../../http/body.js";
import { singleHeader } from "../../http/headers.js";
import { MAX_WOO_CONSENT_STATUS_BYTES, parseWooConsentStatusProbe,
  WooConsentStatusHttpError, type WooConsentStatusProbe } from "./contract.js";

const invalid = () => new WooConsentStatusHttpError(400, "invalid_request");
const whitespace = (character: string | undefined): boolean =>
  character === " " || character === "\t" || character === "\r" || character === "\n";

/** Parse a flat, string-only JSON object; unlike JSON.parse alone, reject duplicate keys.
 * This is intentionally limited to the three strings in status-v1's wire contract.
 */
function decodeFlatJson(bytes: Buffer): Record<string, string> {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw invalid(); }
  let pos = 0;
  const space = () => { while (whitespace(text[pos])) pos++; };
  const take = (character: string) => { space(); if (text[pos] !== character) throw invalid(); pos++; };
  const quoted = (): string => {
    space();
    const start = pos;
    if (text[pos++] !== '"') throw invalid();
    let closed = false;
    while (pos < text.length) {
      const character = text[pos++];
      if (character === "\\") { if (pos >= text.length) throw invalid(); pos++; continue; }
      if (character === '"') { closed = true; break; }
    }
    if (!closed) throw invalid();
    try { return JSON.parse(text.slice(start, pos)) as string; }
    catch { throw invalid(); }
  };
  take("{");
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = 0; index < 3; index++) {
    const key = quoted();
    if (Object.hasOwn(fields, key)) throw invalid();
    take(":");
    fields[key] = quoted();
    space();
    if (index < 2) take(",");
  }
  take("}");
  space();
  if (pos !== text.length) throw invalid();
  return fields;
}

/** Authenticate installation before this reads attacker-controlled body bytes. */
export async function readWooConsentStatusRequest(request: IncomingMessage): Promise<WooConsentStatusProbe> {
  const contentType = singleHeader(request, "content-type");
  const encoding = singleHeader(request, "content-encoding");
  const length = singleHeader(request, "content-length");
  if (contentType.count !== 1 ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.value ?? "") ||
    encoding.count > 1 || (encoding.count === 1 && encoding.value?.toLowerCase() !== "identity") ||
    length.count > 1 || (length.count === 1 && !/^\d+$/.test(length.value ?? ""))) throw invalid();
  if (length.value && Number(length.value) > MAX_WOO_CONSENT_STATUS_BYTES) {
    throw new WooConsentStatusHttpError(413, "request_too_large");
  }
  const bytes = await readBoundedBody(request, MAX_WOO_CONSENT_STATUS_BYTES, reason =>
    new WooConsentStatusHttpError(reason === "oversized" ? 413 : 400,
      reason === "oversized" ? "request_too_large" : "invalid_request"));
  if (!bytes.length) throw invalid();
  return parseWooConsentStatusProbe(decodeFlatJson(bytes));
}
