import type { IncomingMessage } from "node:http";
import { decodeStrictJsonBody, readBoundedBody } from "../../../http/body.js";
import { ConversationControlRequestError, MAX_CONTROL_BODY_BYTES, parseControlRequest } from "./contract.js";

/** A flat-object decoder: duplicate keys (including escaped equivalents) are forbidden.
 * An ordinary JSON.parse silently keeps the last value, which is unsafe for CAS. */
function decodeFlatControlBody(bytes: Buffer): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let pos = 0;
  const ws = () => { while (/\s/.test(source[pos] ?? "") && pos < source.length) pos++; };
  const quoted = (): string => {
    const start = pos;
    if (source[pos++] !== '"') throw new Error("string expected");
    let escaped = false;
    while (pos < source.length) {
      const char = source[pos++]!;
      if (!escaped && char === '"') return JSON.parse(source.slice(start, pos)) as string;
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
    }
    throw new Error("unterminated string");
  };
  ws();
  if (source[pos++] !== "{") throw new Error("object expected");
  const keys = new Set<string>();
  const parsed: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  ws();
  if (source[pos] === "}") throw new Error("fields missing");
  for (;;) {
    ws();
    const key = quoted();
    if (keys.has(key)) throw new Error("duplicate key");
    keys.add(key);
    ws();
    if (source[pos++] !== ":") throw new Error("colon expected");
    ws();
    let value: unknown;
    if (source[pos] === '"') value = quoted();
    else {
      const match = source.slice(pos).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
      if (!match) throw new Error("scalar expected");
      pos += match[0].length;
      value = JSON.parse(match[0]) as number;
    }
    parsed[key] = value;
    ws();
    if (source[pos] === "}") { pos++; break; }
    if (source[pos++] !== ",") throw new Error("comma expected");
  }
  ws();
  if (pos !== source.length) throw new Error("trailing input");
  // Decode a second time using the shared strict UTF-8 primitive, ensuring
  // control chars and malformed JSON are never silently normalised.
  decodeStrictJsonBody(bytes);
  return parsed;
}

export async function readConversationControlRequest(request: IncomingMessage) {
  const types: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === "content-type") types.push(request.rawHeaders[i + 1] ?? "");
  }
  if (types.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(types[0]!)) {
    throw new ConversationControlRequestError(400, "invalid_request");
  }
  try {
    const bytes = await readBoundedBody(request, MAX_CONTROL_BODY_BYTES,
      (reason) => new ConversationControlRequestError(reason === "oversized" ? 413 : 400,
        reason === "oversized" ? "request_too_large" : "invalid_request"));
    return parseControlRequest(decodeFlatControlBody(bytes));
  } catch (error) {
    if (error instanceof ConversationControlRequestError) throw error;
    throw new ConversationControlRequestError(400, "invalid_request");
  }
}
