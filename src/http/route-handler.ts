import type { IncomingMessage, ServerResponse } from "node:http";

/** A handler claims a request only when its path and HTTP method match. */
export interface ApiRouteHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}
