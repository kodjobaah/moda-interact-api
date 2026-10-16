import type { IncomingMessage } from "node:http";

/**
 * Read a bounded Node request stream without changing the route's error contract.
 * The caller supplies its existing 400/413 domain error constructors and byte limit.
 */
export function readBoundedBody(
  request: IncomingMessage,
  maximumBytes: number,
  failure: (reason: "invalid" | "oversized") => Error,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAbort);
      request.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximumBytes) {
        cleanup();
        request.resume();
        reject(failure("oversized"));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onAbort = () => {
      cleanup();
      reject(failure("invalid"));
    };
    const onError = () => {
      cleanup();
      reject(failure("invalid"));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onError);
  });
}

/** Strict UTF-8/JSON decoding; callers retain their existing domain validators. */
export function decodeStrictJsonBody(bytes: Buffer): unknown {
  const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (bodyText.includes("\0")) throw new Error("nul");
  return JSON.parse(bodyText) as unknown;
}
