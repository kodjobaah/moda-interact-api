import { createServer, type Server, type ServerResponse } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { ReadinessDatabase } from "./database.js";
import type { RuntimeConfig } from "./runtime-config.js";
import type { ApiRouteHandler } from "./http/route-handler.js";

export interface ApiRuntime {
  server: Server;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

interface ApiServerOptions {
  database: ReadinessDatabase;
  logger: StructuredLogger;
  readinessTimeoutMs: number;
  routes: readonly ApiRouteHandler[];
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, string>>,
): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function probeWithinDeadline(
  probe: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("readiness_timeout")), timeoutMs);
    Promise.resolve()
      .then(probe)
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout));
  });
}

function createHttpServer({
  database,
  logger,
  readinessTimeoutMs,
  routes,
}: ApiServerOptions): Server {
  return createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && requestUrl.pathname === "/health/live") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/health/ready") {
      void probeWithinDeadline(() => database.probe(), readinessTimeoutMs).then(
        () => sendJson(response, 200, { status: "ready" }),
        (error: unknown) => {
          logger.warn("api.readiness.failed", {
            reason:
              error instanceof Error && error.message === "readiness_timeout"
                ? "timeout"
                : "database_unavailable",
          });
          if (!response.destroyed) {
            sendJson(response, 503, { status: "not_ready" });
          }
        },
      );
      return;
    }

    void dispatchApiRoutes(request, response, routes).then(
      (handled) => {
        if (!handled && !response.destroyed && !response.headersSent) {
          sendJson(response, 404, { error: "not_found" });
        }
      },
      () => {
        if (!response.destroyed && !response.headersSent) {
          sendJson(response, 500, { error: "internal_error" });
        }
      },
    );
  });
}

async function dispatchApiRoutes(
  request: Parameters<ApiRouteHandler["handle"]>[0],
  response: ServerResponse,
  routes: readonly ApiRouteHandler[],
): Promise<boolean> {
  for (const route of routes) {
    if (await route.handle(request, response)) return true;
  }
  return false;
}

export function createApiRuntime(
  config: RuntimeConfig,
  database: ReadinessDatabase,
  logger: StructuredLogger,
  routes: readonly ApiRouteHandler[] = [],
): ApiRuntime {
  const server = createHttpServer({
    database,
    logger,
    readinessTimeoutMs: config.readinessTimeoutMs,
    routes,
  });
  let startPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  return {
    server,
    start() {
      startPromise ??= new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(config.port, config.host, () => {
          server.off("error", onError);
          logger.info("api.started", { host: config.host, port: config.port });
          resolve();
        });
      });
      return startPromise;
    },
    shutdown() {
      shutdownPromise ??= (async () => {
        logger.info("api.shutdown.started");
        let closeError: Error | undefined;
        if (server.listening) {
          await new Promise<void>((resolve) => {
            server.close((error) => {
              closeError = error;
              resolve();
            });
          });
        }

        try {
          await database.disconnect();
        } catch {
          logger.error("api.shutdown.database_disconnect_failed");
          throw new Error("database disconnect failed");
        }

        if (closeError) {
          logger.error("api.shutdown.server_close_failed");
          throw new Error("HTTP server close failed");
        }
        logger.info("api.shutdown.completed");
      })();
      return shutdownPromise;
    },
  };
}

export function registerShutdownHandlers(
  runtime: ApiRuntime,
  signalSource: SignalSource = process,
  onFailure: () => void = () => {
    process.exitCode = 1;
  },
): void {
  const shutdown = () => {
    void runtime.shutdown().catch(() => onFailure());
  };
  signalSource.once("SIGINT", shutdown);
  signalSource.once("SIGTERM", shutdown);
}