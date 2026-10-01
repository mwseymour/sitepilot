import type { IncomingMessage, ServerResponse } from "node:http";

import type { DatabaseStatus } from "./database.js";

/**
 * SitePilot's hosted backend (MCP plan, Phase 5). It runs the same services
 * as the desktop app (@sitepilot/core) on Supabase Postgres. So far it only
 * answers the health check; the request, review and MCP routes come next.
 */

export const SERVER_VERSION = "0.1.0";

export type SecretsStatus =
  | "ok"
  | "waiting_for_database"
  | "not_configured"
  | "invalid_key";

export type ServerInfo = {
  version: string;
  /** The deployed commit, shortened. Null outside Railway. */
  commit: string | null;
  region: string | null;
  startedAt: string;
};

export function serverInfoFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): ServerInfo {
  return {
    version: SERVER_VERSION,
    commit: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    region: env.RAILWAY_REPLICA_REGION ?? null,
    startedAt: now.toISOString()
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  method: string | undefined
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(method === "HEAD" ? undefined : text);
}

/** The app's own routes; true when one handled the request. */
export type Routes = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<boolean>;

export function createRequestHandler(
  info: ServerInfo,
  databaseStatus: () => DatabaseStatus = () => ({ status: "not_configured" }),
  secretsStatus: () => SecretsStatus = () => "not_configured",
  routes: () => Routes | null = () => null
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const readOnly = request.method === "GET" || request.method === "HEAD";
    // The process is up even while the database is still connecting, so
    // this stays 200; the body says how the database is doing.
    if (path === "/healthz" && readOnly) {
      const database = databaseStatus();
      sendJson(
        response,
        200,
        {
          status: "ok",
          service: "sitepilot-server",
          ...info,
          database:
            database.status === "connecting"
              ? { status: "connecting", attempts: database.attempts }
              : database,
          secrets: secretsStatus()
        },
        request.method
      );
      return;
    }
    const appRoutes = routes();
    if (appRoutes) {
      appRoutes(request, response)
        .then((handled) => {
          if (!handled) notFound(response, request.method);
        })
        .catch((error: unknown) => {
          console.log(`Request to ${path} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          if (!response.headersSent) {
            sendJson(response, 500, { code: "internal_error", cause: "internal", retryable: true, message: "SitePilot hit an error. Try again." }, request.method);
          } else {
            response.end();
          }
        });
      return;
    }
    if (path !== "/healthz") {
      sendJson(
        response,
        503,
        { code: "editor_unavailable", cause: "host_environment", retryable: true, message: "SitePilot is still starting up." },
        request.method
      );
      return;
    }
    notFound(response, request.method);
  };
}

function notFound(response: ServerResponse, method: string | undefined): void {
  // sitepilot.error/v1, like every other SitePilot error.
  sendJson(
    response,
    404,
    {
      code: "not_found",
      cause: "not_found",
      retryable: false,
      message: "SitePilot's server has no route here."
    },
    method
  );
}
