import type { ServerResponse } from "node:http";

/** Identical no-store JSON response semantics for the selected API route handlers. */
export function sendNoStoreJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
