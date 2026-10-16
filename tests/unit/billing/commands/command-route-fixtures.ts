import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { createBillingCommandRoutes } from "../../../../src/billing/commands/routes.js";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";

export const authorizedHeaders = {
  "x-moda-installation-id": "authenticated-installation",
  authorization: "Bearer authenticated-credential",
  "idempotency-key": "request-123",
  "content-type": "application/json",
};

export type LogEvent = { level: "info" | "warn" | "error"; name: string; data: Record<string, unknown> };
export type CommandFixtureOptions = {
  authError?: Error;
  recurring?: {
    create: (...args: unknown[]) => Promise<unknown>;
    switchPlan: (...args: unknown[]) => Promise<unknown>;
    cancel: (...args: unknown[]) => Promise<unknown>;
  };
  credit?: { initiate: (...args: unknown[]) => Promise<unknown> };
};

export const principal = {
  installationId: "authenticated-installation",
  shopId: "authenticated-shop",
  canonicalSiteUrl: "https://merchant.example",
  credentialVersion: 3,
};

export function commandFixture(options: CommandFixtureOptions = {}) {
  const calls: string[] = [];
  const events: LogEvent[] = [];
  const authenticator = {
    async authenticate(request: IncomingMessage) {
      calls.push("authenticate");
      if (options.authError) throw options.authError;
      if (request.headers.authorization !== authorizedHeaders.authorization ||
          request.headers["x-moda-installation-id"] !== authorizedHeaders["x-moda-installation-id"]) {
        throw new WooUnauthenticatedError();
      }
      return principal;
    },
  };
  const logger = {
    info(name: string, data: Record<string, unknown>) { events.push({ level: "info", name, data }); },
    warn(name: string, data: Record<string, unknown>) { events.push({ level: "warn", name, data }); },
    error(name: string, data: Record<string, unknown>) { events.push({ level: "error", name, data }); },
  };
  const router = createBillingCommandRoutes({
    ...(options.recurring ? { recurringSubscriptionCommandService: options.recurring as never } : {}),
    ...(options.credit ? { recoveryCreditPurchaseCommandService: options.credit as never } : {}),
    authenticator: authenticator as never,
    logger: logger as never,
    now: () => 1_000,
  });
  return { router, calls, events };
}

export async function withCommandRouter(
  router: ReturnType<typeof createBillingCommandRoutes>,
  callback: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void router.handle(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}');
      }
    }).catch(() => {
      if (response.headersSent || response.destroyed) return;
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

export async function rawCommand(
  origin: string,
  path: string,
  method: string,
  rawHeaders: readonly string[],
  body?: string | Buffer,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  const headers: Record<string, string | string[]> = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    const value = rawHeaders[index + 1];
    if (!name || value === undefined) throw new TypeError("incomplete raw header pair");
    const prior = headers[name];
    headers[name] = prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
  }
  return await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: (() => { const payload = Buffer.concat(chunks).toString("utf8"); if (!payload) throw new Error(`missing response body for ${method} ${path}: status ${response.statusCode}`); return JSON.parse(payload) as unknown; })(),
          });
        } catch (error) { reject(error); }
      });
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}

export function rawHeaders(key = "request-123"): string[] {
  return [
    "X-Moda-Installation-Id", authorizedHeaders["x-moda-installation-id"],
    "Authorization", authorizedHeaders.authorization,
    "Idempotency-Key", key,
    "Content-Type", "application/json",
  ];
}
