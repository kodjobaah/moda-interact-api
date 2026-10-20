import type { IncomingMessage } from "node:http";
import { readBoundedBody, decodeStrictJsonBody } from "../../../http/body.js";
import { MAX_SEND_BODY_BYTES, SendHttpError, parseHumanSendInput } from "./contract.js";

/** JSON parser used only for duplicate-key detection. JSON.parse alone silently
 * discards repeated keys (including escaped equivalents) before validation.
 * No eval, no parameter coercion, and a finite nesting depth.
 */
export function decodeNonDuplicateJson(bytes: Buffer): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let i = 0;
  const skip = () => { while (/[\t\n\r ]/.test(source[i] ?? "") && i < source.length) i++; };
  const quoted = (): string => {
    const start = i;
    if (source[i++] !== '"') throw new Error("string");
    let escape = false;
    while (i < source.length) {
      const ch = source[i++]!;
      if (!escape && ch === '"') return JSON.parse(source.slice(start, i)) as string;
      if (!escape && ch === "\\") escape = true;
      else escape = false;
    }
    throw new Error("unterminated");
  };
  const value = (depth: number): void => {
    if (depth > 8) throw new Error("too deep");
    skip();
    if (source[i] === '"') { quoted(); return; }
    if (source[i] === "{") {
      i++; skip(); const keys = new Set<string>();
      if (source[i] === "}") { i++; return; }
      while (i < source.length) {
        skip(); const key = quoted();
        if (keys.has(key)) throw new Error("duplicate key");
        keys.add(key); skip();
        if (source[i++] !== ":") throw new Error("colon");
        value(depth + 1); skip();
        if (source[i] === "}") { i++; return; }
        if (source[i++] !== ",") throw new Error("comma");
      }
      throw new Error("unterminated object");
    }
    if (source[i] === "[") {
      i++; skip(); if (source[i] === "]") { i++; return; }
      while (i < source.length) {
        value(depth + 1); skip();
        if (source[i] === "]") { i++; return; }
        if (source[i++] !== ",") throw new Error("comma");
      }
      throw new Error("unterminated array");
    }
    const token = source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!token) throw new Error("scalar");
    i += token[0].length;
  };
  value(0); skip();
  if (i !== source.length) throw new Error("trailing");
  return decodeStrictJsonBody(bytes);
}
export async function readHumanSendRequest(request: IncomingMessage) {
  const types: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === "content-type") types.push(request.rawHeaders[i+1] ?? "");
  }
  if (types.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(types[0]!))
    throw new SendHttpError(400, "invalid_request");
  try {
    const bytes = await readBoundedBody(request, MAX_SEND_BODY_BYTES, (why) =>
      new SendHttpError(why === "oversized" ? 413 : 400, why === "oversized" ? "request_too_large" : "invalid_request"));
    return parseHumanSendInput(decodeNonDuplicateJson(bytes));
  } catch (error) {
    if (error instanceof SendHttpError) throw error;
    throw new SendHttpError(400, "invalid_request");
  }
}
